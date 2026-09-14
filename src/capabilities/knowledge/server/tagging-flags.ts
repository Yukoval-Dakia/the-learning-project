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
 * Default 0.55, set from a real-embedder probe (YUK-489 P3 gate, n=6 across
 * 数学/物理/生物/语文). This axis uses ASYMMETRIC embed sources — the QUERY embeds the
 * full question text (questionEmbedText), while each KC embeds only `name\ndomain`
 * (knowledgeEmbedText) — which systematically inflates the distance vs a symmetric
 * question↔question compare. In the probe a CORRECT match landed at cosine distance
 * 0.39–0.57, while a wrong-subject KC or a genuinely novel concept stayed ≥ 0.60
 * (clean separation; nearest-is-correct was 5/5 — the RANKING is sound).
 *
 * The quiz matcher's 0.35 (`MATCHER_COSINE_MAX_DISTANCE`, a question↔question axis)
 * is far too tight HERE: it matched 0/5 correct pairs in the probe → every upload
 * would PROPOSE and never MATCH (KC explosion, defeating P1+P2). 0.55 sits inside the
 * correct band yet below the wrong/novel floor (≈ cosine similarity ≥ 0.45 to match).
 *
 * Still **UNTUNED** on a production corpus — n=6 cannot pin the boundary precisely;
 * rigorous calibration on real KC vectors + question text is tracked by
 * YUK-677 (`pnpm audit:threshold-calibration` — report-only replay). Failure mode
 * is non-destructive either way: too-tight → duplicate KCs
 * (caught by the P5 dedup-on-maintenance lane); too-loose → a related-but-wrong match
 * (rarer). A future refinement is to embed a concept-shaped projection of the question
 * (not the raw prompt) for a more symmetric query↔label distance.
 *
 * Env override: set `TAGGING_MATCH_THRESHOLD` to a finite number to override the
 * default at boot (dark-ship / per-env tuning). A non-finite / unparseable value
 * falls back to the default (never silently disables matching).
 */
const DEFAULT_MATCH_THRESHOLD = 0.55;

function resolveMatchThreshold(): number {
  const raw = process.env.TAGGING_MATCH_THRESHOLD;
  if (raw == null || raw.trim() === '') return DEFAULT_MATCH_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MATCH_THRESHOLD;
}

export const MATCH_THRESHOLD: number = resolveMatchThreshold();

/**
 * Retrieval window for the match-or-propose axis: `tagKnowledge` fetches the
 * GLOBALLY nearest `RETRIEVAL_TOP_K` active embedded KCs via
 * `matchKnowledgeBySimilarity` and only THEN drops cross-domain candidates —
 * so an in-domain KC ranked beyond this window is invisible to the match
 * decision. Lives here (not in tag-knowledge.ts) so the YUK-677 calibration
 * replay (`pnpm audit:threshold-calibration`) reads the SAME live value
 * instead of duplicating a driftable constant.
 */
export const RETRIEVAL_TOP_K = 10;
