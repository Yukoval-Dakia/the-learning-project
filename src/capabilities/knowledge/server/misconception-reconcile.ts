// YUK-531 (A5 S4 / ADR-0036 RT1) — write-time reconciliation ring for the
// HETEROGENEOUS misconception_edge layer.
//
// This is the OWN ring that edge-reconcile.ts (the homogeneous knowledge_edge ring)
// explicitly punted ("the heterogeneous misconception edge gets its OWN ring — do NOT
// pre-build for it here … 异构边闸归 RT1"). It is the PURE decision layer ONLY: it
// builds the reconcile prompt and calls GLM to judge how a candidate misconception
// edge relates to its live neighbor misconception edges, then returns a typed
// decision. It does NOT wire into the promotion writer and does NOT touch the schema.
//
// IMPERATIVE, NOT fold: unlike the knowledge_edge ring (which writes generate/correct
// events because knowledge_edge is event-sourced with a fold), misconception has NO
// fold / projection / version column. A SUPERSEDE here is applied IMPERATIVELY by the
// caller: archiveMisconceptionEdge (archived_at soft-archive, idempotent) + a
// misconception_reconciliation_log audit row — no event replay, no known.ts extension.
//
// RING DOMAIN = NON-TOPOLOGICAL SEMANTIC CONTRADICTION. Endpoint-kind validity /
// self-loop / symmetric redundancy are already handled by the parallel heterogeneous
// topology gate (misconception-topology-gate.ts) BEFORE this ring runs. This ring asks
// a different question: does the candidate misconception edge semantically CORRECT /
// contradict a live edge such that the old edge should be retired (SUPERSEDE)?
// e.g. a `confusable_with` edge that a later, more precise edge subsumes.
//
// REUSES the edge ring's GLM call shape: resolveGlmConfig (single GLM-model SoT) +
// ReconcileParseError (one parse-error contract across both rings). Action space is
// {KEEP_BOTH, SUPERSEDE} ONLY (MERGE / RETRACT_NEW are text-memory verbs with no
// structural-edge analog — same reasoning as the edge ring).

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type { Env } from '@/server/memory/client';
import { ReconcileParseError, type ReconcileUsage, resolveGlmConfig } from './edge-reconcile';

const DEFAULT_TIMEOUT_MS = 60_000;

const VALID_ACTIONS = new Set(['KEEP_BOTH', 'SUPERSEDE']);
const CONFIDENCE_THRESHOLD = 0.6;

export type MisconceptionReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE';

/**
 * A candidate misconception_edge being proposed. from_kind is always 'misconception'
 * (RT1 invariant), so only the TARGET carries polymorphism. No real edge UUID is
 * exposed to the LLM — neighbors are referenced by sequential index only.
 */
export type MisconceptionEdgeCandidate = {
  from_id: string;
  to_kind: 'misconception' | 'knowledge' | 'event';
  to_id: string;
  relation_type: string;
  /** Human-readable names threaded for the prompt (NOT ids). */
  from_name?: string;
  to_name?: string;
  /** The proposer's reasoning for this edge — semantic context for the judge. */
  reasoning?: string;
};

/**
 * A live neighbor misconception_edge in the mesh, surfaced as a reconcile candidate.
 * `edge_id` is the REAL misconception_edge row id — kept for carry-back as
 * `superseded_edge_id`, but NEVER written into the prompt (the prompt uses the
 * sequential `index` only).
 */
export type MisconceptionEdgeNeighbor = {
  index: number;
  /** REAL misconception_edge.id — for carry-back only, never exposed to the LLM. */
  edge_id: string;
  from_id: string;
  to_kind: 'misconception' | 'knowledge' | 'event';
  to_id: string;
  relation_type: string;
  from_name?: string;
  to_name?: string;
};

export type MisconceptionReconcileDecision = {
  action: MisconceptionReconcileAction;
  /** Prompt-space index of the neighbor this decision acts on. Required for SUPERSEDE; null for KEEP_BOTH. */
  neighbor_index: number | null;
  /** REAL misconception_edge.id of the superseded edge — resolved from neighbor_index. SUPERSEDE only; null otherwise. */
  superseded_edge_id: string | null;
  confidence: number;
  reason: string;
};

type GlmChatBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format: { type: string };
  temperature?: number;
};

type GlmChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { code?: string | number; message?: string };
};

/** A misconception edge referenced in the prompt by index; describes one endpoint pair. */
function describeEdge(e: {
  from_id: string;
  to_kind: string;
  to_id: string;
  relation_type: string;
  from_name?: string;
  to_name?: string;
}): string {
  const from = e.from_name ? `${e.from_name} (${e.from_id})` : e.from_id;
  const to = e.to_name ? `${e.to_name} (${e.to_id})` : `${e.to_kind}:${e.to_id}`;
  return `misconception:${from} --${e.relation_type}--> ${to}`;
}

/**
 * Build the heterogeneous misconception-edge reconcile prompt.
 *
 * Prompt wording RED LINE (inherited from reconcile-llm.ts / edge-reconcile.ts): NEVER
 * simultaneously contain "smart memory manager" AND "Compare newly retrieved facts" —
 * that pair is the mem0 3.0.7 LangchainLLM residual sniff that would hijack the call
 * into the old MemoryUpdateSchema. This ring shares the GLM endpoint, so the same red
 * line applies. Neighbors are referenced by sequential index 0..n only.
 */
export function buildMisconceptionReconcilePrompt(
  candidate: MisconceptionEdgeCandidate,
  neighbors: MisconceptionEdgeNeighbor[],
): { system: string; user: string } {
  const system = [
    'You decide how one newly proposed MISCONCEPTION-graph edge relates to the',
    'existing live misconception edges around its endpoints. A misconception is a',
    'named mistaken belief; an edge links it to the concept it corrupts (caused_by),',
    'to a confusable counterpart (confusable_with), or to where it was observed',
    '(observed_in). Output exactly one action for the candidate edge. Output ONLY a',
    'JSON object, no prose.',
  ].join(' ');

  const lines: string[] = [];

  lines.push('SCOPE:');
  lines.push(
    '- Endpoint-kind validity, self-loops, and symmetric duplicates are ALREADY handled by a separate gate. Do NOT reason about those here.',
  );
  lines.push(
    '- Your job is SEMANTIC: does the candidate edge CORRECT or contradict the MEANING of an existing edge so that the old edge should be retired?',
  );
  lines.push('');

  lines.push('ACTION SPACE (only these two):');
  lines.push(
    '- KEEP_BOTH: the candidate and every neighbor describe different, coexisting misconception relations. This is the default when in doubt.',
  );
  lines.push(
    '- SUPERSEDE: the candidate is a semantic CORRECTION of ONE existing neighbor edge — that neighbor now states the relation wrongly and should be retired in favor of the candidate. Carry the neighbor_index of the edge being superseded.',
  );
  lines.push('');

  lines.push('PER-RELATION RULES (the candidate relation_type is given below):');
  lines.push(
    '- caused_by: SUPERSEDE only when the candidate corrects the concept this misconception was wrongly attributed to corrupting. Distinct concepts a misconception affects are KEEP_BOTH.',
  );
  lines.push(
    '- confusable_with: SUPERSEDE when the candidate corrects a confusion stated against the wrong counterpart. Genuinely distinct confusions are KEEP_BOTH; lean to KEEP_BOTH.',
  );
  lines.push(
    '- observed_in: provenance of where the misconception was seen. Independent observations are KEEP_BOTH; SUPERSEDE only when the candidate corrects a mis-attributed observation.',
  );
  lines.push('');

  lines.push(
    'Each decision carries a confidence score from 0 to 1. Below 0.6 the system downgrades to KEEP_BOTH (no destructive supersede on low confidence).',
  );
  lines.push('');

  lines.push('OUTPUT JSON shape:');
  lines.push('{');
  lines.push('  "decision": ');
  lines.push(
    '    { "action": "SUPERSEDE", "neighbor_index": 2, "confidence": 0.82, "reason": "..." }',
  );
  lines.push('}');
  lines.push('action must be one of: KEEP_BOTH, SUPERSEDE.');
  lines.push('For KEEP_BOTH, neighbor_index must be null.');
  lines.push('For SUPERSEDE, neighbor_index MUST be the index of the neighbor being retired.');
  lines.push('');

  lines.push('CANDIDATE EDGE:');
  lines.push(`relation_type=${candidate.relation_type}`);
  lines.push(`edge: ${describeEdge(candidate)}`);
  if (candidate.reasoning) {
    lines.push(`proposer_reasoning: ${candidate.reasoning}`);
  }
  lines.push('');

  lines.push('LIVE NEIGHBOR EDGES (around the candidate endpoints):');
  if (neighbors.length === 0) {
    lines.push('No existing neighbor edges.');
  } else {
    for (const n of neighbors) {
      lines.push(`  [neighbor_index=${n.index}] ${describeEdge(n)}`);
    }
  }

  return { system, user: lines.join('\n') };
}

/**
 * Parse GLM's JSON response into a typed decision. Throws ReconcileParseError on:
 * non-JSON body, missing decision object, action outside enum, SUPERSEDE without a
 * valid neighbor_index. superseded_edge_id is resolved from neighbor_index against
 * `neighbors` (the LLM only ever emits indices). A SUPERSEDE naming a neighbor_index
 * not present is a parse error (hallucinated index) so the caller can safe-degrade.
 */
export function parseMisconceptionReconcileResponse(
  raw: string,
  neighbors: MisconceptionEdgeNeighbor[],
): MisconceptionReconcileDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReconcileParseError('GLM misconception-reconcile response is not valid JSON', raw);
  }

  const obj = parsed as { decision?: unknown };
  if (!obj || typeof obj !== 'object' || obj.decision == null || typeof obj.decision !== 'object') {
    throw new ReconcileParseError(
      'GLM misconception-reconcile response missing decision object',
      raw,
    );
  }

  const d = obj.decision as Record<string, unknown>;
  const action = d.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    throw new ReconcileParseError(
      `misconception-reconcile decision has invalid action: ${JSON.stringify(action)}`,
      raw,
    );
  }

  const neighborIndex = d.neighbor_index == null ? null : Number(d.neighbor_index);
  if (neighborIndex !== null && (!Number.isInteger(neighborIndex) || neighborIndex < 0)) {
    throw new ReconcileParseError(
      `misconception-reconcile decision has invalid neighbor_index: ${JSON.stringify(d.neighbor_index)}`,
      raw,
    );
  }

  if (action === 'SUPERSEDE') {
    if (neighborIndex === null) {
      throw new ReconcileParseError(
        'misconception-reconcile decision action=SUPERSEDE requires a non-null neighbor_index',
        raw,
      );
    }
    const neighbor = neighbors.find((n) => n.index === neighborIndex);
    if (!neighbor) {
      throw new ReconcileParseError(
        `misconception-reconcile decision action=SUPERSEDE names neighbor_index ${neighborIndex} not present in the neighbor list`,
        raw,
      );
    }
    return {
      action: 'SUPERSEDE',
      neighbor_index: neighborIndex,
      superseded_edge_id: neighbor.edge_id,
      confidence: Number(d.confidence) || 0,
      reason: typeof d.reason === 'string' ? d.reason : '',
    };
  }

  // KEEP_BOTH — neighbor_index irrelevant; normalize to null.
  return {
    action: 'KEEP_BOTH',
    neighbor_index: null,
    superseded_edge_id: null,
    confidence: Number(d.confidence) || 0,
    reason: typeof d.reason === 'string' ? d.reason : '',
  };
}

/**
 * Apply the confidence threshold: a SUPERSEDE below the threshold is downgraded to
 * KEEP_BOTH (no destructive action on a low-confidence judgment). Mirrors
 * edge-reconcile.ts applyConfidenceThreshold, scoped to this ring's decision type.
 */
export function applyConfidenceThreshold(
  decision: MisconceptionReconcileDecision,
  threshold: number = CONFIDENCE_THRESHOLD,
): MisconceptionReconcileDecision {
  if (decision.action !== 'KEEP_BOTH' && decision.confidence < threshold) {
    return {
      action: 'KEEP_BOTH',
      neighbor_index: null,
      superseded_edge_id: null,
      confidence: decision.confidence,
      reason: `Low confidence (${decision.confidence}); downgraded from ${decision.action}. ${decision.reason}`,
    };
  }
  return decision;
}

/**
 * Call GLM chat/completions to judge misconception-edge reconciliation. Returns a
 * typed decision with the confidence threshold already applied. Throws
 * ReconcileParseError on bad JSON / shape, RetryableError / PermanentError on HTTP
 * failures (mirrors edge-reconcile.ts).
 *
 * SAFE-DEGRADE CONTRACT: empty neighbors short-circuits to KEEP_BOTH WITHOUT a GLM
 * call (nothing to contradict → nothing to reconcile). For a non-empty neighbor set,
 * a parse failure surfaces as ReconcileParseError so the caller can degrade the batch
 * to KEEP_BOTH — the ring never fabricates a destructive SUPERSEDE on an unparseable
 * response.
 */
export async function judgeMisconceptionReconcile(
  candidate: MisconceptionEdgeCandidate,
  neighbors: MisconceptionEdgeNeighbor[],
  opts: {
    env?: Env;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    onUsage?: (usage: ReconcileUsage) => void;
  } = {},
): Promise<MisconceptionReconcileDecision> {
  if (neighbors.length === 0) {
    return {
      action: 'KEEP_BOTH',
      neighbor_index: null,
      superseded_edge_id: null,
      confidence: 1,
      reason: 'No live neighbor edges; nothing to reconcile.',
    };
  }

  const env = opts.env ?? process.env;
  const glmConfig = resolveGlmConfig(env);
  if (!glmConfig.apiKey) {
    throw new PermanentError(
      'GLM misconception-reconcile requires ZHIPU_API_KEY (via mem0 config)',
    );
  }

  const { system, user } = buildMisconceptionReconcilePrompt(candidate, neighbors);
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
      throw new RetryableError(
        `GLM misconception-reconcile request aborted/timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw new RetryableError(`GLM misconception-reconcile network error: ${String(err)}`, {
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
    const message = `GLM misconception-reconcile error [http ${resp.status}${code ? ` code ${code}` : ''}]: ${errBody?.error?.message ?? 'no message'}`;
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
    throw new PermanentError('GLM misconception-reconcile returned a non-JSON 2xx body', {
      cause: err,
    });
  }

  // Surface usage for cost_ledger BEFORE the content/parse guards — a billed-but-empty
  // response still cost money. Guard so a callback throw never corrupts the result.
  if (opts.onUsage && json.usage) {
    try {
      opts.onUsage({
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
      });
    } catch (err) {
      console.error('[misconception-reconcile] onUsage callback failed', err);
    }
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ReconcileParseError(
      'GLM misconception-reconcile response has no message content',
      JSON.stringify(json),
    );
  }

  const decision = parseMisconceptionReconcileResponse(content, neighbors);
  return applyConfidenceThreshold(decision);
}
