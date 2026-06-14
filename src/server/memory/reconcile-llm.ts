import { PermanentError, RetryableError } from '@/core/schema/structured_question';

import { type Env, createMem0Config } from './client';

// P2 (YUK-342): GLM reconciliation judgment layer.
//
// After mem0 add() inserts new memories, this module calls GLM (via the same
// openai-compat endpoint as mem0's own LLM — coding-plan /api/coding/paas/v4)
// to decide how each new memory relates to existing candidates. The fetch
// pattern mirrors glm_ocr.ts (AbortController timeout + Retryable/Permanent
// error classification), but the endpoint is /chat/completions.
//
// This is NOT runTask/resolveTaskProvider (Anthropic-protocol-only). GLM is
// openai-compat and physically unreachable through the Anthropic SDK.

const DEFAULT_TIMEOUT_MS = 60_000;
const VALID_ACTIONS = new Set(['KEEP_BOTH', 'SUPERSEDE', 'MERGE', 'RETRACT_NEW']);
const CONFIDENCE_THRESHOLD = 0.6;

export type ReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW';

export type ReconcileDecision = {
  new_index: number;
  action: ReconcileAction;
  old_index: number | null;
  confidence: number;
  reason: string;
  /**
   * Only meaningful for action=MERGE: the rewritten text that absorbs the new
   * memory into the existing one (becomes the surviving memory's payload.data).
   * parseReconcileResponse REQUIRES this when action=MERGE (else ReconcileParseError
   * → batch degrades to KEEP_BOTH) — never let `reason` stand in for merged text.
   */
  merged_text?: string | null;
};

/** A new memory with its extracted text and metadata for the prompt. */
export type NewMemoryEntry = {
  index: number;
  kind: string;
  text: string;
  memory_id: string;
  /** epoch-ms of the new memory (threaded from the ingest event) for recency. */
  created_ms: number;
};

/** An existing candidate memory for the prompt. */
export type CandidateEntry = {
  index: number;
  text: string;
  memory_id: string;
  created_ms?: number;
};

/** Per-new-memory candidates: new_index → candidates found by search. */
export type CandidatesByNew = Map<number, CandidateEntry[]>;

export class ReconcileParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'ReconcileParseError';
  }
}

type GlmChatBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format: { type: string };
  temperature?: number;
};

type GlmChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { code?: string | number; message?: string };
};

type GlmConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
};

function resolveGlmConfig(env: Env): GlmConfig {
  const mem0Config = createMem0Config(env);
  const llmConfig = mem0Config.llm.config;
  return {
    baseURL: llmConfig.baseURL ?? '',
    apiKey: llmConfig.apiKey ?? '',
    model: String(llmConfig.model ?? 'glm-5.2'),
  };
}

/**
 * Build the GLM reconcile prompt. Per-kind rules follow owner directive:
 *   - preference / habit → single latest truth: SUPERSEDE on contradiction,
 *     MERGE on overlap (recency assumption).
 *   - weakness / event → KEEP_BOTH: episodic facts coexist; only RETRACT_NEW
 *     on exact duplicate. Weakness/error trajectories have value as history.
 *
 * Prompt wording RED LINE: never simultaneously contain "smart memory manager"
 * AND "Compare newly retrieved facts" (mem0 3.0.7 LangchainLLM residual sniff
 * would hijack into old MemoryUpdateSchema). Existing memories are referenced
 * by sequential index 0..n only — never expose real UUIDs to the LLM.
 */
export function buildReconcilePrompt(
  newMems: NewMemoryEntry[],
  candidatesByNew: CandidatesByNew,
): { system: string; user: string } {
  const system = [
    'You decide how each newly stored memory relates to existing stored memories',
    'for a single user. For each new memory you output exactly one action.',
    'Output ONLY a JSON object, no prose.',
  ].join(' ');

  const lines: string[] = [];

  // ACTION SPACE
  lines.push('ACTION SPACE:');
  lines.push(
    '- KEEP_BOTH: both remain; they describe different facts or different points in time.',
  );
  lines.push(
    '- SUPERSEDE: the existing memory is now outdated and the new one wins (keep both rows, mark the old one outdated).',
  );
  lines.push('- MERGE: rewrite the existing memory to absorb the new one, then drop the new one.');
  lines.push('- RETRACT_NEW: the new memory is noise or an exact duplicate; drop it.');
  lines.push('');

  // PER-KIND RULES
  lines.push('PER-KIND RULES (the kind is given for each new memory):');
  lines.push(
    '- kind=preference or habit: lean toward a single latest truth. Prefer SUPERSEDE on contradiction, MERGE on overlap.',
  );
  lines.push(
    '- kind=weakness or event: lean toward KEEP_BOTH. Episodic facts coexist, distinguished by their timeline. Only RETRACT_NEW on exact duplicate.',
  );
  lines.push('');

  // CONFIDENCE
  lines.push(
    'Each decision carries a confidence score from 0 to 1. Below 0.6 the system downgrades to KEEP_BOTH.',
  );
  lines.push('');

  // OUTPUT FORMAT
  lines.push('OUTPUT JSON shape:');
  lines.push('{');
  lines.push('  "decisions": [');
  lines.push(
    '    { "new_index": 0, "action": "SUPERSEDE", "old_index": 2, "confidence": 0.82, "reason": "..." },',
  );
  lines.push(
    '    { "new_index": 1, "action": "MERGE", "old_index": 0, "confidence": 0.8, "reason": "...", "merged_text": "the single rewritten memory that absorbs both" },',
  );
  lines.push(
    '    { "new_index": 2, "action": "KEEP_BOTH", "old_index": null, "confidence": 0.9, "reason": "..." }',
  );
  lines.push('  ]');
  lines.push('}');
  lines.push('action must be one of: KEEP_BOTH, SUPERSEDE, MERGE, RETRACT_NEW.');
  lines.push('For KEEP_BOTH or RETRACT_NEW, old_index may be null.');
  lines.push(
    'For action=MERGE you MUST include "merged_text": the full rewritten memory that combines the existing one with the new one. Do not put the merged text in "reason".',
  );
  lines.push('');

  // NEW MEMORIES
  lines.push('NEW MEMORIES:');
  for (const m of newMems) {
    lines.push(`[new_index=${m.index}] kind=${m.kind}: ${m.text}`);
  }
  lines.push('');

  // EXISTING CANDIDATES (per new memory, indexed 0..n — NO UUIDs exposed)
  lines.push('EXISTING CANDIDATES (per new memory):');
  for (const m of newMems) {
    const cands = candidatesByNew.get(m.index) ?? [];
    if (cands.length === 0) {
      lines.push(`For new_index=${m.index}: no existing candidates.`);
      continue;
    }
    lines.push(`For new_index=${m.index}:`);
    for (const c of cands) {
      const createdStr = c.created_ms ? ` created_ms=${c.created_ms}` : '';
      lines.push(`  [old_index=${c.index}]${createdStr}: ${c.text}`);
    }
  }

  return { system, user: lines.join('\n') };
}

/**
 * Parse GLM's JSON response into typed decisions. Throws ReconcileParseError
 * on: non-JSON body, missing decisions array, action outside enum.
 */
export function parseReconcileResponse(raw: string): ReconcileDecision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReconcileParseError('GLM reconcile response is not valid JSON', raw);
  }

  const obj = parsed as { decisions?: unknown };
  if (!obj || !Array.isArray(obj.decisions)) {
    throw new ReconcileParseError('GLM reconcile response missing decisions array', raw);
  }

  const decisions: ReconcileDecision[] = [];
  for (let i = 0; i < obj.decisions.length; i++) {
    const d = obj.decisions[i] as Record<string, unknown>;
    const action = d?.action;
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
      throw new ReconcileParseError(
        `decision[${i}] has invalid action: ${JSON.stringify(action)}`,
        raw,
      );
    }
    const newIndex = Number(d.new_index);
    if (!Number.isInteger(newIndex) || newIndex < 0) {
      throw new ReconcileParseError(
        `decision[${i}] has invalid new_index: ${JSON.stringify(d.new_index)}`,
        raw,
      );
    }
    const oldIndex = d.old_index == null ? null : Number(d.old_index);
    if (oldIndex !== null && (!Number.isInteger(oldIndex) || oldIndex < 0)) {
      throw new ReconcileParseError(
        `decision[${i}] has invalid old_index: ${JSON.stringify(d.old_index)}`,
        raw,
      );
    }
    // SUPERSEDE / MERGE act on an existing memory — they require an old_index.
    if ((action === 'SUPERSEDE' || action === 'MERGE') && oldIndex === null) {
      throw new ReconcileParseError(
        `decision[${i}] action=${action} requires a non-null old_index`,
        raw,
      );
    }
    // MERGE requires the rewritten text — never let `reason` stand in for it.
    const mergedText = typeof d.merged_text === 'string' ? d.merged_text : null;
    if (action === 'MERGE' && (mergedText === null || mergedText.trim().length === 0)) {
      throw new ReconcileParseError(`decision[${i}] action=MERGE is missing merged_text`, raw);
    }
    decisions.push({
      new_index: newIndex,
      action: action as ReconcileAction,
      old_index: oldIndex,
      confidence: Number(d.confidence) || 0,
      reason: typeof d.reason === 'string' ? d.reason : '',
      merged_text: mergedText,
    });
  }

  if (decisions.length === 0) {
    throw new ReconcileParseError('GLM reconcile response has empty decisions array', raw);
  }

  return decisions;
}

/**
 * Apply confidence threshold: any decision below the threshold is downgraded
 * to KEEP_BOTH (no destructive action on low-confidence judgments).
 */
export function applyConfidenceThreshold(
  decisions: ReconcileDecision[],
  threshold: number = CONFIDENCE_THRESHOLD,
): ReconcileDecision[] {
  return decisions.map((d) =>
    d.confidence < threshold && d.action !== 'KEEP_BOTH'
      ? {
          ...d,
          action: 'KEEP_BOTH' as const,
          old_index: null,
          reason: `Low confidence (${d.confidence}); downgraded from ${d.action}. ${d.reason}`,
        }
      : d,
  );
}

/**
 * Call GLM chat/completions to judge reconciliation. Returns typed decisions.
 * Throws ReconcileParseError on bad JSON, RetryableError/PermanentError on
 * HTTP failures (mirrors glm_ocr.ts pattern).
 */
export async function judgeReconciliation(
  newMems: NewMemoryEntry[],
  candidatesByNew: CandidatesByNew,
  opts: { env?: Env; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ReconcileDecision[]> {
  const env = opts.env ?? process.env;
  const glmConfig = resolveGlmConfig(env);
  if (!glmConfig.apiKey) {
    throw new PermanentError('GLM reconcile requires ZHIPU_API_KEY (via mem0 config)');
  }

  const { system, user } = buildReconcilePrompt(newMems, candidatesByNew);
  const body: GlmChatBody = {
    model: glmConfig.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
  };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetchImpl(`${glmConfig.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${glmConfig.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RetryableError(`GLM reconcile request aborted/timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw new RetryableError(`GLM reconcile network error: ${String(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let errBody: GlmChatResponse | null = null;
    try {
      errBody = (await resp.json()) as GlmChatResponse;
    } catch {
      errBody = null;
    }
    const code = errBody?.error?.code ?? '';
    const message = `GLM reconcile error [http ${resp.status}${code ? ` code ${code}` : ''}]: ${errBody?.error?.message ?? 'no message'}`;
    if (resp.status === 401 || resp.status === 403) {
      throw new PermanentError(message);
    }
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableError(message);
    }
    throw new PermanentError(message);
  }

  let json: GlmChatResponse;
  try {
    json = (await resp.json()) as GlmChatResponse;
  } catch (err) {
    throw new PermanentError('GLM reconcile returned a non-JSON 2xx body', { cause: err });
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ReconcileParseError(
      'GLM reconcile response has no message content',
      JSON.stringify(json),
    );
  }

  const decisions = parseReconcileResponse(content);
  return applyConfidenceThreshold(decisions);
}
