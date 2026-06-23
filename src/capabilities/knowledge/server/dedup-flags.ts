// P5 (YUK-489) — dedup-on-maintenance flags. Mirrors `tagging-flags.ts` /
// `matcher-flags.ts`: module-level consts (no config table) read through IMPORTED
// bindings so db tests can getter-mock them (a same-module bare-identifier read
// cannot be getter-mocked), AND env-overridable so the thresholds can be
// dark-shipped / tuned per environment without a code change.
//
// These govern the nightly `kc_dedup_nightly` job: it detects near-duplicate
// auto-created KC pairs by pgvector cosine distance and emits MERGE PROPOSALS
// (pending inbox items) — PROPOSE-ONLY, never auto-merge (a merge rewrites
// knowledge_ids attribution + sets merged_from[], so it stays behind the human
// accept gate).

/**
 * Cosine-DISTANCE ceiling for "near-duplicate" KC pairs, expressed in pgvector
 * `<=>` units (0 = identical direction .. 2 = opposite). A pair proposes a merge
 * only when its distance is `<= DEDUP_DISTANCE_MAX`.
 *
 * Default **0.10** — deliberately MUCH tighter than the tagging MATCH_THRESHOLD
 * (0.55). A merge is DESTRUCTIVE (archives the `from` KC, rewrites knowledge_ids
 * attribution into `into`, sets merged_from[]), so only VERY-close pairs should
 * even propose. The human accept gate is the real false-positive filter; the
 * tight distance keeps the inbox signal-dense rather than flooding it with
 * loosely-related pairs the owner would just dismiss.
 *
 * **UNTUNED** — n=0 calibration; the value is a conservative starting point.
 * Rigorous calibration on a real KC corpus is a follow-up (Refs YUK-396).
 * Failure mode is non-destructive either way: too-tight → a true duplicate is
 * missed (stays as two KCs, no harm beyond minor redundancy); too-loose → a
 * related-but-distinct pair proposes (the human dismisses it).
 *
 * Env override: set `KC_DEDUP_DISTANCE_MAX` to a finite number to override the
 * default at boot. A non-finite / unparseable value falls back to the default.
 */
const DEFAULT_DEDUP_DISTANCE_MAX = 0.1;

/**
 * Lookback window (days) for the budget bound: the scan considers only KC pairs
 * where at least one side was minted recently by auto-tagging (an
 * `experimental:auto_tag_kc_created` event inside this window). Default **7**.
 *
 * Env override: `KC_DEDUP_WINDOW_DAYS` (finite positive number; else default).
 */
const DEFAULT_DEDUP_WINDOW_DAYS = 7;

/**
 * Per-run cap on the number of near-dup pairs the scan turns into proposals
 * (ORDER BY distance ASC, LIMIT this). Default **50** — bounds inbox churn and
 * keeps a single nightly run cheap. The leftover pairs (beyond the cap) are
 * picked up on subsequent nightly runs as the window rolls forward.
 *
 * Env override: `KC_DEDUP_MAX_PAIRS` (finite positive integer; else default).
 */
const DEFAULT_DEDUP_MAX_PAIRS = 50;

function resolveFinite(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const n = resolveFinite(raw, fallback);
  // A non-positive override (0 / negative) would silently disable the scan or
  // error at the DB LIMIT — fall back to the default instead.
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

export const DEDUP_DISTANCE_MAX: number = resolveFinite(
  process.env.KC_DEDUP_DISTANCE_MAX,
  DEFAULT_DEDUP_DISTANCE_MAX,
);

export const DEDUP_WINDOW_DAYS: number = resolvePositiveInt(
  process.env.KC_DEDUP_WINDOW_DAYS,
  DEFAULT_DEDUP_WINDOW_DAYS,
);

export const DEDUP_MAX_PAIRS: number = resolvePositiveInt(
  process.env.KC_DEDUP_MAX_PAIRS,
  DEFAULT_DEDUP_MAX_PAIRS,
);
