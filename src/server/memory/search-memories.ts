import type { SearchResult } from 'mem0ai/oss';
import type { MemoryClient } from './client';

// P3 (YUK-351): the mem0 READ-path wrapper. All mem0 fact reads converge on this
// single seam (design doc 2026-06-13-memory-architecture.md §3.6 / §8 line 217):
//
//   1. overfetch topK × OVERFETCH_FACTOR candidates with the NOT-superseded
//      filter forwarded to mem0;
//   2. drop any soft-superseded item the store still returned (defense-in-depth —
//      the P2 reconcile marker lands on `metadata.superseded_by`, reconcile-store.ts);
//   3. recency-rerank `score' = score × exp(-ln2 × ageDays / halfLifeDays)`, with a
//      per-kind half-life (preference/habit long, event short) — this is the TS-side
//      temporal boost the 3.x SDK lacks (§3.6);
//   4. truncate to topK.
//
// READ-ONLY on CORE: this never mutates due / mastery / FSRS and never writes mem0
// (ADR-0017 — memory is an attention prior, not a source of truth).

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LN2 = Math.LN2;

/**
 * How many candidates to overfetch before reranking + truncating. Design §3.6:
 * "topK × 2~3". 3 gives the recency rerank enough headroom that a fresh but
 * lower-raw-score item can climb into the topK without a second round-trip.
 */
export const OVERFETCH_FACTOR = 3;

/**
 * Upper bound on the post-floor topK. The store request fans out to
 * `topK × OVERFETCH_FACTOR` candidates; without a cap a runaway caller topK
 * would balloon the overfetch (and the embedding/pgvector cost) unbounded. 50 is
 * far above any realistic attention-prior window (callers default to 10).
 */
export const MAX_TOPK = 50;

/**
 * Per-kind half-life (days) for the recency decay. preference/habit are durable
 * (slow decay → long half-life); weakness is medium; event/episodic is short
 * (recent attempts matter most). An unknown / unset kind falls back to
 * DEFAULT_HALF_LIFE_DAYS (balanced 60d — matches LONG_TERM_FRESHNESS_BUDGET).
 * kind taxonomy mirrors mapEventActionToKind (triggers.ts) + the reconcile prompt
 * (reconcile-llm.ts): preference / habit / weakness / event.
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
};

// mem0's MemoryItem surfaces non-excluded payload keys (created_ms / kind /
// superseded_by) flat under `metadata` (oss search() projection). The SDK type is
// `metadata?: Record<string, any>` — read defensively.
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

// created_ms is written by P2 as a `::text` cast (reconcile-store.ts) so it can
// come back as a numeric string; addEventMemory writes it as a JS number. Accept
// both, fall back to the ISO `createdAt`, and finally to now (age 0 → no decay).
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
  // Mirror the P2 sentinel discipline (reconcile-store.ts): superseded_by is set
  // to a non-null id when a row is soft-superseded, never JSON null. Treat any
  // present non-empty value as superseded.
  const v = meta.superseded_by;
  return v !== undefined && v !== null && v !== '';
}

/**
 * Read mem0 facts with soft-superseded filtering + per-kind recency rerank.
 *
 * The NOT-superseded filter is forwarded to mem0 (uppercase `NOT` per design
 * §3.3, translated by mem0's _processMetadataFilters on `search()`), AND a
 * belt-and-suspenders application-layer drop runs over the returned items — so
 * the wrapper still excludes superseded rows even if a future client path or a
 * stub ignores the filter.
 */
export async function searchMemories(
  client: Pick<MemoryClient, 'search'>,
  query: string,
  opts: SearchMemoriesOpts,
): Promise<SearchResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const topK = Math.min(MAX_TOPK, Math.max(1, Math.floor(opts.topK)));

  // Uppercase NOT: the `search()` path translation (§3.3). $not is the getAll
  // form and would be mis-parsed here.
  const supersededFilter = { superseded_by: '*' };
  // Merge — do NOT overwrite — any caller-supplied NOT. Spreading opts.filters
  // and then assigning NOT would silently drop a caller NOT clause; instead
  // concat the caller's NOT (array or single object) with the superseded filter.
  const callerNot = opts.filters?.NOT;
  const mergedNot = callerNot
    ? [...(Array.isArray(callerNot) ? callerNot : [callerNot]), supersededFilter]
    : [supersededFilter];

  const filters: SearchFilters = {
    ...(opts.filters ?? {}),
    NOT: mergedNot,
  };

  // Fix 2 (OCR): mem0 retrieval is a read-only attention prior (ADR-0017) and
  // must never crash the tool chain. A store/embedding failure degrades to an
  // empty result set rather than propagating — the caller treats "no memories"
  // and "memories unavailable" identically (a softer prior either way).
  let raw: SearchResult;
  try {
    raw = await client.search(query, {
      topK: topK * OVERFETCH_FACTOR,
      filters,
    });
  } catch (err) {
    // ADR-0017: memory is an attention prior, not a source of truth — surface
    // the failure to logs but do not throw. Do not swallow silently.
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
      // Capture the original store index so equal rerankScores break ties on it
      // (below). Without this, a set of all-zero-score items (no numeric score)
      // would collapse to rerankScore 0 and an engine-dependent sort could
      // reorder — and drop the most relevant zero-score item on truncation.
      return { item, meta, rerankScore: baseScore * decay, origIndex };
    })
    .filter(({ meta }) => !isSuperseded(meta))
    // Descending by rerankScore; ties (including all-zero) keep original store
    // order via the origIndex tiebreaker so truncation is deterministic.
    .sort((a, b) => b.rerankScore - a.rerankScore || a.origIndex - b.origIndex)
    .slice(0, topK)
    .map(({ item }) => item);

  return { results: reranked };
}
