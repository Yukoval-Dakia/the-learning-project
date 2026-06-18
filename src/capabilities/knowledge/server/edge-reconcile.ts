// ADR-0034 §3 — write-time reconciliation ring (knowledge-edge structural layer).
//
// Spec: docs/adr/0034-knowledge-structure-consistency-gate-supersedes-bitemporal.md §3
//
// This is INCREMENT 1: the PURE decision layer ONLY. It builds the reconcile
// prompt and calls GLM to judge how a candidate knowledge_edge relates to its
// live neighbor edges, then returns a typed decision. It does NOT wire into
// `runEdgeProposeAndWrite` (propose_edge.ts) and does NOT touch the schema —
// that wiring is increment 2+. Nothing here imports propose_edge.ts.
//
// WHY a SEPARATE module from src/server/memory/reconcile-llm.ts (ADR-0034 §备选
// 末条, the rejected "use mem0 P2 reconcile ring directly" option): mem0's ring
// acts on a personalization collection (soft profile, goes stale, recency-
// supersede bias). Knowledge edges are STRUCTURE (timeless, strong schema). The
// two action spaces differ — mem0 has {KEEP_BOTH, SUPERSEDE, MERGE, RETRACT_NEW}
// (MERGE rewrites memory text, RETRACT_NEW drops a noisy duplicate), but a
// structural edge has NO text body to MERGE and "drop the new one" is what the
// topology/rubric gates already do upstream. So this ring's action space is
// {KEEP_BOTH, SUPERSEDE} ONLY. We REUSE the GLM call shape, ReconcileParseError,
// and applyConfidenceThreshold from reconcile-llm.ts (same skeleton, ADR-0034 §3
// "复用 P2 reconcile 骨架"), but redefine the prompt + action space + parse for
// the structural domain.
//
// RING DOMAIN = NON-TOPOLOGICAL SEMANTIC CONTRADICTION. Topology (cycle /
// direction contradiction / transitive redundancy) is already hard-rejected by
// topology-gate.ts BEFORE the ring runs (propose_edge.ts checkEdgeTopology). The
// ring asks a different question: does this new edge semantically CORRECT /
// contradict a live edge such that the old edge should be retired (SUPERSEDE),
// even though both are topologically valid? e.g. a stronger-evidence
// `prerequisite` edge that the learner's trajectory now shows is wrong-direction
// in MEANING (not graph topology), or a `contrasts_with` edge that a later, more
// precise edge subsumes.
//
// HOMOGENEOUS edges ONLY: both endpoints are knowledge_id (ADR-0010 同构边). The
// heterogeneous misconception edge (RT1, from_kind/to_kind polymorphic) gets its
// OWN ring — do NOT pre-build for it here (ADR-0034 §后果 "异构边闸归 RT1").

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import { type Env, createMem0Config } from '@/server/memory/client';

const DEFAULT_TIMEOUT_MS = 60_000;

// Structural-edge action space: KEEP_BOTH | SUPERSEDE ONLY.
//   - KEEP_BOTH: the candidate and the live neighbor describe different, coexisting
//     structural relations — keep both edges live.
//   - SUPERSEDE: the candidate is a semantic CORRECTION of an existing live edge;
//     the old edge is now wrong/outdated and should be retired (archived). The
//     decision CARRIES the superseded old edge id so the caller (increment 2+) can
//     archive exactly that row.
// MERGE / RETRACT_NEW are deliberately ABSENT — they are text-memory verbs with no
// structural-edge analog (see module header).
const VALID_ACTIONS = new Set(['KEEP_BOTH', 'SUPERSEDE']);
const CONFIDENCE_THRESHOLD = 0.6;

export type EdgeReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE';

/** The five core relation types this ring covers (ADR-0010 / blocks.ts). */
export type EdgeRelationType =
  | 'prerequisite'
  | 'related_to'
  | 'contrasts_with'
  | 'applied_in'
  | 'derived_from';

/**
 * A candidate homogeneous knowledge_edge being proposed. Both endpoints are
 * knowledge_id (同构边). No real edge UUID is exposed to the LLM — the candidate
 * has no id of its own yet (it is not persisted), and neighbors are referenced by
 * sequential index only (see buildEdgeReconcilePrompt).
 */
export type EdgeCandidate = {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: EdgeRelationType;
  /** Human-readable names threaded for the prompt (NOT ids). */
  from_name?: string;
  to_name?: string;
  /** The proposer's reasoning for this edge — semantic context for the judge. */
  reasoning?: string;
};

/**
 * A live neighbor edge already in the mesh, surfaced as a reconcile candidate.
 * `edge_id` is the REAL knowledge_edge row id — kept on the typed neighbor so the
 * decision can carry it back as `superseded_edge_id`, but it is NEVER written into
 * the prompt (the prompt uses sequential `neighbor_index` only).
 */
export type EdgeNeighbor = {
  /** Sequential index used in the prompt (0..n). */
  index: number;
  /** REAL knowledge_edge.id — for carry-back only, never exposed to the LLM. */
  edge_id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: EdgeRelationType;
  from_name?: string;
  to_name?: string;
};

export type EdgeReconcileDecision = {
  action: EdgeReconcileAction;
  /**
   * The prompt-space index of the neighbor this decision acts on. Required (non-
   * null) for SUPERSEDE; null for KEEP_BOTH.
   */
  neighbor_index: number | null;
  /**
   * The REAL knowledge_edge.id of the superseded edge — resolved from
   * `neighbor_index` against the neighbor list AFTER parsing (the LLM only ever
   * sees / emits indices). Only meaningful for SUPERSEDE; null for KEEP_BOTH.
   */
  superseded_edge_id: string | null;
  confidence: number;
  reason: string;
};

// Reuse the SAME error type name + shape as reconcile-llm.ts so callers can
// catch one ReconcileParseError contract across both rings.
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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { code?: string | number; message?: string };
};

/** Token usage surfaced to the caller so it can write cost_ledger (mirrors reconcile-llm.ts). */
export type ReconcileUsage = { promptTokens: number; completionTokens: number };

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

/** A neighbor referenced in the prompt by index; describes one endpoint pair. */
function describeEdge(e: {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: EdgeRelationType;
  from_name?: string;
  to_name?: string;
}): string {
  const from = e.from_name ? `${e.from_name} (${e.from_knowledge_id})` : e.from_knowledge_id;
  const to = e.to_name ? `${e.to_name} (${e.to_knowledge_id})` : e.to_knowledge_id;
  return `${from} --${e.relation_type}--> ${to}`;
}

/**
 * Build the structural-edge reconcile prompt.
 *
 * Per-RELATION rules (the candidate's relation_type drives the framing — owner
 * ruling: cover ALL relation types, not just prerequisite). The ring's job is
 * NON-TOPOLOGICAL semantic contradiction; topology (cycle/direction/transitive)
 * is already hard-rejected upstream by topology-gate.ts, so the prompt explicitly
 * scopes the judge AWAY from graph-shape reasoning.
 *
 * Prompt wording RED LINE (inherited from reconcile-llm.ts §108-111): NEVER
 * simultaneously contain "smart memory manager" AND "Compare newly retrieved
 * facts" — that pair is the mem0 3.0.7 LangchainLLM residual sniff that would
 * hijack the call into the old MemoryUpdateSchema. This ring shares the GLM
 * endpoint, so the same red line applies. Neighbors are referenced by sequential
 * index 0..n only — never expose real edge UUIDs to the LLM.
 */
export function buildEdgeReconcilePrompt(
  candidate: EdgeCandidate,
  neighbors: EdgeNeighbor[],
): { system: string; user: string } {
  const system = [
    'You decide how one newly proposed knowledge-graph EDGE relates to the',
    'existing live edges around its endpoints. Knowledge edges are structural',
    'and timeless. Output exactly one action for the candidate edge.',
    'Output ONLY a JSON object, no prose.',
  ].join(' ');

  const lines: string[] = [];

  // SCOPE — the ring is semantic only; topology is handled elsewhere.
  lines.push('SCOPE:');
  lines.push(
    '- Graph SHAPE problems (cycles, reversed direction, redundant transitive paths) are ALREADY handled by a separate gate. Do NOT reason about graph shape here.',
  );
  lines.push(
    '- Your job is SEMANTIC: does the candidate edge CORRECT or contradict the MEANING of an existing edge so that the old edge should be retired?',
  );
  lines.push('');

  // ACTION SPACE — KEEP_BOTH | SUPERSEDE only.
  lines.push('ACTION SPACE (only these two):');
  lines.push(
    '- KEEP_BOTH: the candidate and every neighbor describe different, coexisting structural relations. This is the default when in doubt.',
  );
  lines.push(
    '- SUPERSEDE: the candidate is a semantic CORRECTION of ONE existing neighbor edge — that neighbor now states the relation wrongly and should be retired in favor of the candidate. Carry the neighbor_index of the edge being superseded.',
  );
  lines.push('');

  // PER-RELATION RULES — cover ALL relation types.
  lines.push('PER-RELATION RULES (the candidate relation_type is given below):');
  lines.push(
    '- prerequisite: SUPERSEDE only when the candidate states a corrected learning-order dependency that a neighbor prerequisite edge got semantically wrong (e.g. the dependency was attributed to the wrong concept). Mere co-existing dependencies are KEEP_BOTH.',
  );
  lines.push(
    '- related_to: lean strongly to KEEP_BOTH — relatedness is non-exclusive. SUPERSEDE only when a neighbor related_to edge has been refined into a more precise relation by the candidate and is now redundant-and-wrong (not merely redundant).',
  );
  lines.push(
    '- contrasts_with: SUPERSEDE when the candidate corrects a contrast that a neighbor stated against the wrong counterpart concept. Distinct, genuine contrasts are KEEP_BOTH.',
  );
  lines.push(
    '- derived_from / applied_in: directional provenance/usage. SUPERSEDE when the candidate corrects a mis-attributed source/application that a neighbor edge recorded. Independent derivations/applications are KEEP_BOTH.',
  );
  lines.push('');

  // CONFIDENCE
  lines.push(
    'Each decision carries a confidence score from 0 to 1. Below 0.6 the system downgrades to KEEP_BOTH (no destructive supersede on low confidence).',
  );
  lines.push('');

  // OUTPUT FORMAT — single decision for the candidate.
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

  // CANDIDATE EDGE
  lines.push('CANDIDATE EDGE:');
  lines.push(`relation_type=${candidate.relation_type}`);
  lines.push(`edge: ${describeEdge(candidate)}`);
  if (candidate.reasoning) {
    lines.push(`proposer_reasoning: ${candidate.reasoning}`);
  }
  lines.push('');

  // LIVE NEIGHBOR EDGES (indexed 0..n — NO real edge UUIDs exposed)
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
 * non-JSON body, missing decision object, action outside enum, SUPERSEDE without
 * a valid neighbor_index. The superseded_edge_id is resolved from neighbor_index
 * against `neighbors` (the LLM only ever emits indices). A SUPERSEDE that names a
 * neighbor_index not present in the neighbor list is a parse error (hallucinated
 * index) so the caller can safe-degrade the batch to KEEP_BOTH.
 */
export function parseEdgeReconcileResponse(
  raw: string,
  neighbors: EdgeNeighbor[],
): EdgeReconcileDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReconcileParseError('GLM edge-reconcile response is not valid JSON', raw);
  }

  const obj = parsed as { decision?: unknown };
  if (!obj || typeof obj !== 'object' || obj.decision == null || typeof obj.decision !== 'object') {
    throw new ReconcileParseError('GLM edge-reconcile response missing decision object', raw);
  }

  const d = obj.decision as Record<string, unknown>;
  const action = d.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    throw new ReconcileParseError(
      `edge-reconcile decision has invalid action: ${JSON.stringify(action)}`,
      raw,
    );
  }

  const neighborIndex = d.neighbor_index == null ? null : Number(d.neighbor_index);
  if (neighborIndex !== null && (!Number.isInteger(neighborIndex) || neighborIndex < 0)) {
    throw new ReconcileParseError(
      `edge-reconcile decision has invalid neighbor_index: ${JSON.stringify(d.neighbor_index)}`,
      raw,
    );
  }

  if (action === 'SUPERSEDE') {
    if (neighborIndex === null) {
      throw new ReconcileParseError(
        'edge-reconcile decision action=SUPERSEDE requires a non-null neighbor_index',
        raw,
      );
    }
    const neighbor = neighbors.find((n) => n.index === neighborIndex);
    if (!neighbor) {
      throw new ReconcileParseError(
        `edge-reconcile decision action=SUPERSEDE names neighbor_index ${neighborIndex} not present in the neighbor list`,
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

  // KEEP_BOTH — neighbor_index is irrelevant; normalize to null.
  return {
    action: 'KEEP_BOTH',
    neighbor_index: null,
    superseded_edge_id: null,
    confidence: Number(d.confidence) || 0,
    reason: typeof d.reason === 'string' ? d.reason : '',
  };
}

/**
 * Apply the confidence threshold: a SUPERSEDE below the threshold is downgraded
 * to KEEP_BOTH (no destructive action on a low-confidence judgment). Mirrors
 * reconcile-llm.ts applyConfidenceThreshold, scoped to this ring's 2-action space.
 */
export function applyConfidenceThreshold(
  decision: EdgeReconcileDecision,
  threshold: number = CONFIDENCE_THRESHOLD,
): EdgeReconcileDecision {
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
 * Call GLM chat/completions to judge edge reconciliation. Returns a typed
 * decision with the confidence threshold already applied. Throws
 * ReconcileParseError on bad JSON / shape, RetryableError / PermanentError on
 * HTTP failures (mirrors reconcile-llm.ts / glm_ocr.ts classification).
 *
 * SAFE-DEGRADE CONTRACT: empty neighbors short-circuits to KEEP_BOTH WITHOUT a
 * GLM call (no neighbor to contradict → nothing to reconcile). For a non-empty
 * neighbor set, a parse failure surfaces as ReconcileParseError so the caller
 * (increment 2+) can degrade the whole batch to KEEP_BOTH — the ring never
 * fabricates a destructive SUPERSEDE on an unparseable response.
 */
export async function judgeEdgeReconcile(
  candidate: EdgeCandidate,
  neighbors: EdgeNeighbor[],
  opts: {
    env?: Env;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    onUsage?: (usage: ReconcileUsage) => void;
  } = {},
): Promise<EdgeReconcileDecision> {
  // No neighbors → nothing to reconcile against → KEEP_BOTH. Skip the GLM call
  // entirely (cheaper + deterministic); a topologically-valid edge with no live
  // neighbor cannot semantically contradict anything.
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
    throw new PermanentError('GLM edge-reconcile requires ZHIPU_API_KEY (via mem0 config)');
  }

  const { system, user } = buildEdgeReconcilePrompt(candidate, neighbors);
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
        `GLM edge-reconcile request aborted/timed out after ${timeoutMs}ms`,
        {
          cause: err,
        },
      );
    }
    throw new RetryableError(`GLM edge-reconcile network error: ${String(err)}`, {
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
    const message = `GLM edge-reconcile error [http ${resp.status}${code ? ` code ${code}` : ''}]: ${errBody?.error?.message ?? 'no message'}`;
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
    throw new PermanentError('GLM edge-reconcile returned a non-JSON 2xx body', { cause: err });
  }

  // Surface usage for cost_ledger BEFORE the content/parse guards — a billed-but-
  // empty response still cost money (mirrors reconcile-llm.ts YUK-359). Guard so a
  // callback throw never corrupts the reconcile result.
  if (opts.onUsage && json.usage) {
    try {
      opts.onUsage({
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
      });
    } catch (err) {
      console.error('[edge-reconcile] onUsage callback failed', err);
    }
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ReconcileParseError(
      'GLM edge-reconcile response has no message content',
      JSON.stringify(json),
    );
  }

  const decision = parseEdgeReconcileResponse(content, neighbors);
  return applyConfidenceThreshold(decision);
}
