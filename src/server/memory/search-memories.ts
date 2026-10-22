import type { SearchResult } from 'mem0ai/oss';
import type { Mem0OpaqueOperationContext } from '../ai/provider-attempt-runtime';
import type { MemoryClient } from './client';

// The single mem0 read path: overfetch, drop soft-superseded rows, apply a
// per-kind recency decay, then truncate. Memory is a read-only attention prior
// (ADR-0017), never a source of truth, and this module never mutates scheduling,
// due, mastery, or FSRS state.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LN2 = Math.LN2;

/**
 * Overfetch factor before rerank: enough headroom for a fresh but lower-scored
 * item to climb into the topK without a second round-trip.
 */
export const OVERFETCH_FACTOR = 3;

/**
 * Cap the overfetch. Callers ask for topK × factor candidates, so a runaway topK
 * would balloon embedding and pgvector cost; callers default to 10.
 */
export const MAX_TOPK = 50;

/**
 * Per-kind half-life in days. Durable preferences decay slowly; episodic events
 * decay fast. Unknown kinds take the balanced fallback.
 */
export const KIND_HALF_LIFE_DAYS = {
  preference: 180,
  habit: 180,
  weakness: 90,
  event: 30,
} as const;

/** Balanced fallback half-life for an unknown / unset kind. */
export const DEFAULT_HALF_LIFE_DAYS = 60;

type SearchOpts = NonNullable<Parameters<MemoryClient['search']>[1]>;
type SearchFilters = NonNullable<SearchOpts['filters']>;

export type SearchMemoriesOpts = {
  /** Final number of memories to return after rerank + truncation. */
  topK: number;
  /** Extra mem0 filters (e.g. `{ scope_key: 'topic:k1' }`); merged with NOT-superseded. */
  filters?: SearchFilters;
  /** Injectable clock for deterministic recency tests. Defaults to `new Date()`. */
  now?: Date;
  providerOperation: Mem0OpaqueOperationContext;
};

// mem0 surfaces non-excluded payload keys (created_ms / kind / superseded_by) flat
// under `metadata`; the SDK type is loose, so read defensively.
function getMetadata(item: SearchResult['results'][number]): Record<string, unknown> {
  const m = (item as { metadata?: unknown }).metadata;
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
}

function halfLifeForKind(kind: unknown): number {
  if (typeof kind === 'string' && kind in KIND_HALF_LIFE_DAYS) {
    return KIND_HALF_LIFE_DAYS[kind as keyof typeof KIND_HALF_LIFE_DAYS];
  }
  return DEFAULT_HALF_LIFE_DAYS;
}

// created_ms can arrive as a text-cast numeric string (soft-supersede writes it as
// text) or as a JS number (inferred adds). Accept both, fall back to ISO createdAt,
// then to now (age 0, no decay).
function createdMsForItem(
  item: SearchResult['results'][number],
  meta: Record<string, unknown>,
  nowMs: number,
): number {
  const raw = meta.created_ms;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  const createdAt = (item as { createdAt?: unknown }).createdAt;
  if (typeof createdAt === 'string') {
    const t = Date.parse(createdAt);
    if (!Number.isNaN(t)) return t;
  }
  return nowMs;
}

function isSuperseded(meta: Record<string, unknown>): boolean {
  // Supersede markers are always a present non-null id, never JSON null, so any
  // present non-empty value means superseded.
  const v = meta.superseded_by;
  return v !== undefined && v !== null && v !== '';
}

/**
 * Read learner facts with soft-supersede filtering and per-kind recency rerank.
 * The NOT filter is forwarded to mem0 and also applied locally, so a client path
 * or stub that ignores it still cannot surface a superseded row.
 */
export async function searchMemories(
  client: Pick<MemoryClient, 'search'>,
  query: string,
  opts: SearchMemoriesOpts,
): Promise<SearchResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const topK = Math.min(MAX_TOPK, Math.max(1, Math.floor(opts.topK)));

  // Uppercase NOT is the form search() translates; $not belongs to getAll.
  const supersededFilter = { superseded_by: '*' };
  // Concat, do not overwrite, a caller-supplied NOT clause.
  const callerNot = opts.filters?.NOT;
  const mergedNot = callerNot
    ? [...(Array.isArray(callerNot) ? callerNot : [callerNot]), supersededFilter]
    : [supersededFilter];

  const filters: SearchFilters = {
    ...(opts.filters ?? {}),
    NOT: mergedNot,
  };

  // Memory is an attention prior, not a source of truth: a store or embedding
  // failure degrades to no facts instead of breaking the caller's tool chain.
  let raw: SearchResult;
  try {
    raw = await client.search(
      query,
      {
        topK: topK * OVERFETCH_FACTOR,
        filters,
      },
      opts.providerOperation,
    );
  } catch (err) {
    // Log, don't throw: "no memories" and "memories unavailable" both soften the prior.
    console.warn('[searchMemories] mem0 search failed; degrading to empty results (ADR-0017)', err);
    return { results: [] };
  }

  const candidates = raw.results ?? [];

  const reranked = candidates
    .map((item, origIndex) => {
      const meta = getMetadata(item);
      const baseScore = typeof item.score === 'number' ? item.score : 0;
      const ageDays = Math.max(0, (nowMs - createdMsForItem(item, meta, nowMs)) / MS_PER_DAY);
      const halfLife = halfLifeForKind(meta.kind);
      const decay = Math.exp((-LN2 * ageDays) / halfLife);
      // Keep the original store index as a tiebreaker: all-zero scores must not
      // let an engine-dependent sort reorder items and drop a relevant one.
      return { item, meta, rerankScore: baseScore * decay, origIndex };
    })
    .filter(({ meta }) => !isSuperseded(meta))
    // Descending rerankScore; equal scores keep store order, so truncation is deterministic.
    .sort((a, b) => b.rerankScore - a.rerankScore || a.origIndex - b.origIndex)
    .slice(0, topK)
    .map(({ item }) => item);

  return { results: reranked };
}
