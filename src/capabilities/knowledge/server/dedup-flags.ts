// P5 (YUK-489) — dedup-on-maintenance flags. Mirrors `tagging-flags.ts` /
// `matcher-flags.ts`: module-level consts (no config table) read through IMPORTED
// bindings so db tests can getter-mock them (a same-module bare-identifier read
// cannot be getter-mocked), AND env-overridable so the thresholds can be
// dark-shipped / tuned per environment without a code change.
//
// YUK-1007：const → 函数读者（dedupDistanceMax/dedupWindowDays/dedupMaxPairs）。
// 「≤0 = 静默禁用」规则已由 registry zod schema 承担（写端拦下），reader 侧叠加
// 本地防御。
//
// These govern the nightly `kc_dedup_nightly` job: it detects near-duplicate
// auto-created KC pairs by pgvector cosine distance and emits MERGE PROPOSALS
// (pending inbox items) — PROPOSE-ONLY, never auto-merge. Accepting a merge runs
// applyMerge, which archives the `from` KC, appends `into.merged_from[]`, AND (YUK-543)
// repairs 9 downstream attribution surfaces per absorbed id (question/learning_item/goal
// knowledge_ids, knowledge_edge endpoints, mastery/fsrs/axis/kc_typed per-KC state,
// misconception edge targets) — so it stays behind the human accept gate.

/**
 * Cosine-DISTANCE ceiling for "near-duplicate" KC pairs, expressed in pgvector
 * `<=>` units (0 = identical direction .. 2 = opposite). A pair proposes a merge
 * only when its distance is `<= DEDUP_DISTANCE_MAX`.
 *
 * Default **0.10** — deliberately MUCH tighter than the tagging MATCH_THRESHOLD
 * (0.55). A merge is DESTRUCTIVE (archives the `from` KC, rewrites knowledge_ids
 * attribution into `into`, sets merged_from[], and repairs the other attribution
 * surfaces — YUK-543), so only VERY-close pairs should even propose. The human accept
 * gate is the real false-positive filter; the
 * tight distance keeps the inbox signal-dense rather than flooding it with
 * loosely-related pairs the owner would just dismiss.
 *
 * **UNTUNED** — n=0 calibration; the value is a conservative starting point.
 * Rigorous calibration on a real KC corpus is tracked by YUK-677
 * (`pnpm audit:threshold-calibration` — report-only replay).
 * Failure mode is non-destructive either way: too-tight → a true duplicate is
 * missed (stays as two KCs, no harm beyond minor redundancy); too-loose → a
 * related-but-distinct pair proposes (the human dismisses it).
 *
 * Env override: set `KC_DEDUP_DISTANCE_MAX` to a POSITIVE finite number to override
 * the default at boot. A non-finite, non-positive (≤0), or unparseable value falls
 * back to the default — cosine distance is always > 0, so a ≤0 ceiling would silently
 * disable all dedup (OCR #4).
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

import { getConfig } from '@/core/config/store';

export function dedupDistanceMax(): number {
  // YUK-1007：DB > env > code-default(0.1)。env/DB 层各保证正有限值——
  // reader 侧叠加非正/非有限防御保留原 fail-safe（手动注入行仍不过层）。
  const v = getConfig('KC_DEDUP_DISTANCE_MAX');
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_DEDUP_DISTANCE_MAX;
}

export function dedupWindowDays(): number {
  const v = getConfig('KC_DEDUP_WINDOW_DAYS');
  const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_DEDUP_WINDOW_DAYS;
}

export function dedupMaxPairs(): number {
  const v = getConfig('KC_DEDUP_MAX_PAIRS');
  const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_DEDUP_MAX_PAIRS;
}
