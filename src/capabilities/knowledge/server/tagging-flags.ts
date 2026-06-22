// P2 (YUK-489) — unified match-or-propose tagging flags. Mirrors the
// `matcher-flags.ts` / `practice/selection-constants.ts` pattern: a module-level
// const (no config table) read through an IMPORTED binding so db tests can
// getter-mock it (a same-module bare-identifier read cannot be getter-mocked).
//
// Unlike `matcher.ts`'s in-file `MATCHER_COSINE_MAX_DISTANCE`, this lives in its
// own module AND is env-overridable so the threshold can be dark-shipped / tuned
// per environment without a code change (design §3 "tagging-flags.ts (matcher-flags.ts
// 模式) 可调/dark-ship").

/**
 * MATCH-vs-PROPOSE cutoff for the unified TaggingTask, expressed as a pgvector
 * **cosine DISTANCE** ceiling (matching `matchKnowledgeBySimilarity`'s
 * `cosine_distance`: 0 = identical direction .. 2 = opposite). The nearest
 * candidate is a MATCH when its `cosine_distance <= MATCH_THRESHOLD`; otherwise
 * the question gets a freshly-PROPOSED child KC.
 *
 * Default 0.35 mirrors the quiz matcher's `MATCHER_COSINE_MAX_DISTANCE` (≈ cosine
 * similarity ≥ 0.65 to match). It is **UNTUNED** — there is no production embedding
 * distribution behind it yet, so a thin/cold-start tree intentionally errs toward
 * PROPOSE (too-eager MATCH would mis-attribute to the only available node, the
 * subject root). Tighten toward reuse once the tree grows. Calibration is a
 * follow-up (Refs YUK-396 — the same un-tuned-threshold concern as the matcher).
 *
 * Env override: set `TAGGING_MATCH_THRESHOLD` to a finite number to override the
 * default at boot (dark-ship / per-env tuning). A non-finite / unparseable value
 * falls back to the default (never silently disables matching).
 */
const DEFAULT_MATCH_THRESHOLD = 0.35;

function resolveMatchThreshold(): number {
  const raw = process.env.TAGGING_MATCH_THRESHOLD;
  if (raw == null || raw.trim() === '') return DEFAULT_MATCH_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MATCH_THRESHOLD;
}

export const MATCH_THRESHOLD: number = resolveMatchThreshold();
