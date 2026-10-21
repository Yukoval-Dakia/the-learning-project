// Knowledge-edge reconciliation: decide whether a candidate edge keeps both or
// semantically supersedes a live neighbor.
//
// This is semantic, not topological. Cycles, direction and transitive redundancy
// are rejected upstream by the topology gate before this runs.
//
// The action space is only KEEP_BOTH and SUPERSEDE. Memory's MERGE/RETRACT_NEW
// verbs do not apply to structural edges: there is no text to merge, and dropping
// the candidate already belongs to the upstream gates. Only homogeneous edges are
// covered; misconception edges get their own ring.

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import {
  type DirectProviderOperationOptions,
  createDirectProviderOperationContext,
  executeDirectProviderAttempt,
  glmChatCostCny,
  isDirectProviderAttemptInvariantError,
} from '@/server/ai/direct-provider-attempt';
import { type Env, memoryLlmHeaders, resolveMemoryLlmConfig } from '@/server/memory/client';

const DEFAULT_TIMEOUT_MS = 60_000;

export type EdgeProviderAttemptOptions = DirectProviderOperationOptions;

export function isEdgeReconcileInvariantError(error: unknown): boolean {
  return isDirectProviderAttemptInvariantError(error);
}

// KEEP_BOTH keeps coexisting relations; SUPERSEDE marks one old edge as wrong and
// carries its id so the caller can archive exactly that row.
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

/** A proposed edge. It has no id yet, and the model sees names, never ids. */
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
 * A live neighbor. `edge_id` is for carry-back only and is never put in the prompt;
 * the model references neighbors by `index`.
 */
export type EdgeNeighbor = {
  index: number;
  edge_id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: EdgeRelationType;
  from_name?: string;
  to_name?: string;
};

export type EdgeReconcileDecision = {
  action: EdgeReconcileAction;
  /** Required for SUPERSEDE; null for KEEP_BOTH. */
  neighbor_index: number | null;
  /** Resolved from `neighbor_index` after parsing; null for KEEP_BOTH. */
  superseded_edge_id: string | null;
  confidence: number;
  reason: string;
};

// Same name and shape as the memory ring's error, so callers catch one contract.
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
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { code?: string | number; message?: string };
};

export type GlmConfig = ReturnType<typeof resolveMemoryLlmConfig>;

export const resolveGlmConfig = resolveMemoryLlmConfig;

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
 * Build the prompt. Rules are framed per relation type, and graph-shape reasoning
 * is explicitly out of scope. Never put both "smart memory manager" and "Compare
 * newly retrieved facts" in the prompt: that pair triggers the memory schema
 * sniff on this shared GLM endpoint. Neighbors stay index-only.
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

  lines.push('SCOPE:');
  lines.push(
    '- Graph SHAPE problems (cycles, reversed direction, redundant transitive paths) are ALREADY handled by a separate gate. Do NOT reason about graph shape here.',
  );
  lines.push(
    '- Your job is SEMANTIC: does the candidate edge CORRECT or contradict the MEANING of an existing edge so that the old edge should be retired?',
  );
  lines.push('');

  lines.push('ACTION SPACE (only these two):');
  lines.push(
    '- KEEP_BOTH: the candidate and every neighbor describe different, coexisting structural relations. This is the default when in doubt.',
  );
  lines.push(
    '- SUPERSEDE: the candidate is a semantic CORRECTION of ONE existing neighbor edge — that neighbor now states the relation wrongly and should be retired in favor of the candidate. Carry the neighbor_index of the edge being superseded.',
  );
  lines.push('');

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
 * Parse the model response. Bad JSON, a missing decision, an unknown action or a
 * SUPERSEDE with a missing/hallucinated neighbor index all throw, so the caller can
 * degrade rather than act on a bad decision.
 */
export function parseEdgeReconcileResponse(
  raw: string,
  neighbors: EdgeNeighbor[],
): EdgeReconcileDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReconcileParseError('Edge reconcile response is not valid JSON', raw);
  }

  const obj = parsed as { decision?: unknown };
  if (!obj || typeof obj !== 'object' || obj.decision == null || typeof obj.decision !== 'object') {
    throw new ReconcileParseError('Edge reconcile response missing decision object', raw);
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

  // KEEP_BOTH carries no target.
  return {
    action: 'KEEP_BOTH',
    neighbor_index: null,
    superseded_edge_id: null,
    confidence: Number(d.confidence) || 0,
    reason: typeof d.reason === 'string' ? d.reason : '',
  };
}

/** Downgrade a low-confidence SUPERSEDE to KEEP_BOTH; never destroy on doubt. */
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
 * Judge an edge against its neighbors, with the confidence threshold applied.
 * Bad JSON/shape throws ReconcileParseError; HTTP failures throw retryable or
 * permanent errors. Empty neighbors skip the model and keep both, so an
 * unparseable response can never fabricate a destructive supersede.
 */
export async function judgeEdgeReconcile(
  candidate: EdgeCandidate,
  neighbors: EdgeNeighbor[],
  opts: {
    env?: Env;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    providerAttempt?: EdgeProviderAttemptOptions;
  } = {},
): Promise<EdgeReconcileDecision> {
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
  const glmConfig = resolveMemoryLlmConfig(env);
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
  if (!opts.providerAttempt) {
    throw new TypeError('judgeEdgeReconcile requires provider attempt context');
  }
  const providerOperation = createDirectProviderOperationContext(opts.providerAttempt);
  const result = await executeDirectProviderAttempt(
    providerOperation,
    {
      provider: glmConfig.provider,
      model: glmConfig.model,
      lane: 'glm.knowledge-edge-reconcile',
      protocol: 'http',
      endpointClass: 'openai-compatible.chat-completions',
      operationKind: 'edge_reconcile',
      unknownCostCurrency: glmConfig.provider === 'glm' ? 'CNY' : 'USD',
    },
    async (attempt) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(`${glmConfig.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${glmConfig.apiKey}`,
            ...memoryLlmHeaders(glmConfig, attempt.attemptId),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        attempt.markTerminal(
          aborted ? 'aborted' : 'failed',
          aborted ? 'provider_request_aborted' : 'provider_network_error',
        );
        if (aborted) {
          throw new RetryableError(
            `Edge reconcile request aborted/timed out after ${timeoutMs}ms`,
            { cause: err },
          );
        }
        throw new RetryableError(`Edge reconcile network error: ${String(err)}`, {
          cause: err,
        });
      } finally {
        clearTimeout(timer);
      }

      const headerRequestId = resp.headers.get('x-request-id');
      if (headerRequestId) await attempt.recordExternalRequestId(headerRequestId);
      if (!resp.ok) {
        attempt.markTerminal('failed', `provider_http_${resp.status}`);
        let errBody: GlmChatResponse | null = null;
        try {
          errBody = (await resp.json()) as GlmChatResponse;
        } catch {
          errBody = null;
        }
        const bodyRequestId = errBody?.id?.trim();
        if (!headerRequestId && bodyRequestId) {
          await attempt.recordExternalRequestId(bodyRequestId);
        }
        const code = errBody?.error?.code ?? '';
        const message = `Edge reconcile error [http ${resp.status}${code ? ` code ${code}` : ''}]: ${errBody?.error?.message ?? 'no message'}`;
        if (resp.status === 401 || resp.status === 403) throw new PermanentError(message);
        if (resp.status === 429 || resp.status >= 500) throw new RetryableError(message);
        throw new PermanentError(message);
      }

      let json: GlmChatResponse;
      try {
        json = (await resp.json()) as GlmChatResponse;
      } catch (err) {
        attempt.markTerminal('failed', 'provider_response_malformed');
        throw new PermanentError('Edge reconcile returned a non-JSON 2xx body', {
          cause: err,
        });
      }
      if (!headerRequestId && json.id) await attempt.recordExternalRequestId(json.id);

      const promptTokens = json.usage?.prompt_tokens;
      const completionTokens = json.usage?.completion_tokens;
      const totalTokens = json.usage?.total_tokens;
      const hasReportedTokens =
        typeof promptTokens === 'number' ||
        typeof completionTokens === 'number' ||
        typeof totalTokens === 'number';
      const hasPricedTokens =
        typeof promptTokens === 'number' || typeof completionTokens === 'number';
      if (hasReportedTokens) {
        attempt.reportUsage({
          input: typeof promptTokens === 'number' ? promptTokens : null,
          output: typeof completionTokens === 'number' ? completionTokens : null,
          total: typeof totalTokens === 'number' ? totalTokens : null,
        });
      }
      if (hasPricedTokens && glmConfig.provider === 'glm') {
        const estimatedCostCny = glmChatCostCny(promptTokens ?? 0, completionTokens ?? 0);
        attempt.estimateCost({
          amount: estimatedCostCny,
          currency: 'CNY',
          source: 'glm-chat-pricebook',
        });
      }

      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        attempt.markTerminal('failed', 'provider_response_malformed');
        throw new ReconcileParseError(
          'Edge reconcile response has no message content',
          JSON.stringify(json),
        );
      }
      try {
        return applyConfidenceThreshold(parseEdgeReconcileResponse(content, neighbors));
      } catch (err) {
        attempt.markTerminal('failed', 'provider_response_malformed');
        throw err;
      }
    },
  );
  return result.value;
}
