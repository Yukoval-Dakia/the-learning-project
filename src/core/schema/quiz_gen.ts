// Search-grounded QuizGen (T-SQ) — Zod types.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
//   §0  Decisive constraint: search-call provenance cannot be recovered from
//       logs, so the QuizGen agent MUST self-declare its sources. These types
//       are built around that self-declaration.
//   §2  Data model — `question.metadata.quiz_gen` (jsonb, zero migration).
//   §5  Q2 — the QuizGenTask LLM structured output schema.
//
// Two layers live here:
//   1. Persisted shape  — `QuizGenMetadata` (what lands in question.metadata.quiz_gen).
//   2. LLM output shape  — `QuizGenOutput` (what the QuizGenTask agent emits;
//      the Q3 handler maps it into questions + metadata).
import { z } from 'zod';
import { AgentRef, QuestionKind, Rubric } from './business';

// ---------- §2 persisted metadata.quiz_gen ----------

// Where a source URL was used in generation. 'fact' = grounded a factual claim
// in the question; 'inspiration' = informed the topic/framing only. Drives the
// QuizVerify grounding + copy_safety checks (Q5).
export const QuizGenUsedFor = z.enum(['fact', 'inspiration']);
export type QuizGenUsedForT = z.infer<typeof QuizGenUsedFor>;

// §0: every URL the agent actually used must appear here (agent self-reported —
// it cannot be recovered from runner logs).
export const QuizGenSourceRef = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  snippet: z.string().optional(),
  used_for: QuizGenUsedFor,
  // true when the agent pulled full content via tavily_extract (not just search snippet).
  extracted: z.boolean(),
});
export type QuizGenSourceRefT = z.infer<typeof QuizGenSourceRef>;

export const QuizGenSourcePack = z.object({
  query_plan: z.array(z.string().min(1)),
  searched_at: z.string().min(1),
  tool: z.literal('tavily'),
});
export type QuizGenSourcePackT = z.infer<typeof QuizGenSourcePack>;

// YUK-216 S2 / YUK-224 (slice 3, tier 3 'material_grounded') — the REAL source
// material the agent fetched and grounds its questions in (e.g. a reading passage
// / authentic dataset). The agent SELF-REPORTS this block (provenance is NOT
// recoverable from runner logs, §0); the Q3 handler then persists `body_md` to a
// `source_document` row (with `provenance` carrying the URL) and back-fills the
// resulting row id into metadata.quiz_gen.material_source_document_id. The agent
// cannot know that id (it is minted at persist time), so the OUTPUT carries the
// material CONTENT + URL, not the doc id.
export const QuizGenMaterial = z.object({
  // the fetched material itself — the passage / dataset text the questions probe.
  // This is what gets persisted to source_document.body_md and is the "真原文"
  // a reading question is grounded in (spec §6.1 row 3: 原文持久化 + 题面强制引用).
  body_md: z.string().min(1),
  // where the material came from. Persisted into source_document.provenance.
  url: z.string().url(),
  title: z.string().min(1),
  // ISO string (same shape as source_pack.searched_at).
  fetched_at: z.string().min(1),
});
export type QuizGenMaterialT = z.infer<typeof QuizGenMaterial>;

// YUK-216 S2 — 'material_grounded' (tier 3 "material"): QuizGen first fetches
// REAL source material (e.g. a reading passage / authentic dataset), persists it
// to source_document, then writes questions that probe that material. The grounded
// material's id is carried in metadata.quiz_gen.material_source_document_id (see
// QuizGenMetadata below). Code-contract addition only — no DDL.
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §2.1 / §4.
export const QuizGenGenerationMethod = z.enum([
  'search_grounded',
  'closed_book',
  'material_grounded',
]);
export type QuizGenGenerationMethodT = z.infer<typeof QuizGenGenerationMethod>;

export const QuizGenCopySafetyVerdict = z.enum(['original', 'too_close', 'unknown']);
export type QuizGenCopySafetyVerdictT = z.infer<typeof QuizGenCopySafetyVerdict>;

export const QuizGenCopySafety = z.object({
  verdict: QuizGenCopySafetyVerdict,
  // normalized n-gram overlap (0-1) when computed; absent on a pure agent self-assessment.
  max_overlap: z.number().min(0).max(1).optional(),
  checked_by: z.enum(['agent_self', 'quiz_verify']),
});
export type QuizGenCopySafetyT = z.infer<typeof QuizGenCopySafety>;

// Two-axis verification result written by QuizVerifyTask (Q5). Absent until the
// chained quiz_verify job runs.
export const QuizGenVerification = z.object({
  status: z.enum(['verified', 'needs_review', 'failed']),
  summary: z.string(),
  verified_by: AgentRef,
});
export type QuizGenVerificationT = z.infer<typeof QuizGenVerification>;

export const QuizGenMetadata = z
  .object({
    source_pack: QuizGenSourcePack,
    source_refs: z.array(QuizGenSourceRef),
    generation_method: QuizGenGenerationMethod,
    copy_safety: QuizGenCopySafety,
    // Set by QuizGenTask handler on successful parse (Q3). 'ready' = generated,
    // pending verification.
    generation_status: z.literal('ready'),
    verification: QuizGenVerification.optional(),
    // YUK-216 S2 — tier 3 'material_grounded' only: the source_document row id the
    // generated questions are grounded in. question has no source_document_id column
    // (zero-DDL), so material provenance lives here in the quiz_gen metadata
    // namespace. Absent for search_grounded / closed_book. deriveSourceTier() reads
    // this (with generation_method='material_grounded') to land tier 3.
    // docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §2.1 / §2.3.
    material_source_document_id: z.string().min(1).optional(),
  })
  .superRefine((meta, ctx) => {
    // Time-ordering guard: a 'material_grounded' row MUST carry the grounding
    // material id, otherwise it would land in the question table flagged as tier 3
    // by deriveSourceTier yet be demoted to tier 4 (no material id → fails the tier-3
    // branch). Make the contract reject the half-formed shape at parse time. The live
    // material writer (slice 3 / YUK-224) persists the source_document first, so it
    // naturally satisfies this; this guard fails fast if any earlier writer flips the
    // method without wiring the id.
    if (meta.generation_method === 'material_grounded' && !meta.material_source_document_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['material_source_document_id'],
        message:
          "generation_method='material_grounded' requires material_source_document_id (YUK-224)",
      });
    }
  });
export type QuizGenMetadataT = z.infer<typeof QuizGenMetadata>;

// ---------- §5 Q2 QuizGenTask LLM output ----------

// Per-question shape. Mirrors the EmbeddedCheck question contract (kind +
// prompt_md + reference_md + optional choices/judge/rubric) plus QuizGen-only
// fields: difficulty, knowledge_ids the question targets, and the per-question
// source_refs the agent self-declares (§0).
export const QuizGenQuestion = z.object({
  kind: QuestionKind,
  prompt_md: z.string().min(1),
  reference_md: z.string().min(1),
  choices_md: z.array(z.string().min(1)).max(6).nullable().optional(),
  // Only judge routes a GENERATED question can actually be graded by. The judge
  // layer's RUNNABLE_ROUTES is { exact, keyword, semantic, steps, unit_dimension },
  // but 'steps' / 'unit_dimension' are first-class / profile-preferred routes
  // (math derivation, physics units), never generator overrides, and 'rubric' has
  // no runner at all. Allowing those here would let a verified question enter the
  // review pool yet return `unsupported` the moment the learner submits an answer.
  // The QuizGen handler routes derivation/prose to semantic, choice to exact, etc.
  judge_kind_override: z.enum(['exact', 'keyword', 'semantic']).nullable().optional(),
  rubric_json: Rubric.nullable().optional(),
  difficulty: z.number().int().min(1).max(5),
  knowledge_ids: z.array(z.string().min(1)),
  // §0 self-declared: the URLs (subset of the run's source_pack) that grounded
  // or inspired THIS question.
  source_refs: z.array(QuizGenSourceRef),
});
export type QuizGenQuestionT = z.infer<typeof QuizGenQuestion>;

export const QuizGenOutput = z
  .object({
    questions: z.array(QuizGenQuestion).min(1).max(10),
    source_pack: QuizGenSourcePack,
    generation_method: QuizGenGenerationMethod,
    // Agent's own copy-safety self-assessment (§0 / §1). QuizVerify (Q5) may later
    // overwrite metadata.copy_safety with checked_by='quiz_verify'.
    self_copy_safety: QuizGenCopySafety,
    // YUK-224 (slice 3) — the fetched material a `material_grounded` run grounds its
    // questions in. Absent for search_grounded / closed_book; REQUIRED (enforced
    // below) for material_grounded so the Q3 handler can persist it to source_document
    // and back-fill material_source_document_id.
    material: QuizGenMaterial.nullable().optional(),
  })
  .superRefine((out, ctx) => {
    // §0 — a `search_grounded` question MUST carry at least one source_ref. Search
    // provenance is NOT recoverable from runner logs, so an empty source_refs on a
    // search-grounded question would persist a draft with zero URL provenance that
    // QuizVerify (closed-book) can only trust blindly (deterministic overlap is 0
    // with no snippet). `closed_book` legitimately allows empty refs.
    if (out.generation_method === 'search_grounded') {
      out.questions.forEach((q, i) => {
        if (q.source_refs.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'search_grounded question must declare at least one source_ref (§0 self-reported provenance)',
            path: ['questions', i, 'source_refs'],
          });
        }
      });
    }
    // YUK-224 (slice 3) — material grounding 正向校验。PR #312 的 V1 时序守卫
    // （拒收一切 material_grounded 输出，等 live writer 落地）已被本 slice 取代：
    // 素材检索 + source_document 持久化 + material_source_document_id 回填的 live
    // writer 现在就在 quiz_gen handler 里（runQuizGen material_grounded 分支）。
    // 守卫从「拒收」翻转为「必须携带 material 来源」：material_grounded 时 output
    // 必须自报 `material`（passage 原文 + URL），handler 才能据此持久化 source_document
    // 并回填 doc id（metadata 层 superRefine 已就位：material_source_document_id 必填，
    // 由 handler 回填后满足）。漏报 material → 无真原文可持久化，deriveSourceTier 会把
    // 题降到 tier 4 跳过 material_grounding 检查 → 在 parse 期 fail-fast（spec §6.1
    // row 3「阅读类题有真原文：原文持久化 + 题面强制引用」的入口约束）。
    if (out.generation_method === 'material_grounded' && !out.material) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "generation_method='material_grounded' requires a `material` block (real source passage + URL) so the handler can persist it to source_document (YUK-224)",
        path: ['material'],
      });
    }
  });
export type QuizGenOutputT = z.infer<typeof QuizGenOutput>;

// ---------- §5 Q5 QuizVerifyTask LLM output ----------
//
// Two-axis verification (mirrors VariantVerificationResult but adds the
// copy_safety axis). QuizVerify is CLOSED-BOOK (§1 default): it trusts the
// agent's self-reported source_refs and does NOT run its own Tavily loop. It
// answers three §5 checks, each carrying its own verdict + note, then rolls them
// up into an `overall` verdict that the Q5 handler maps to the Option-B gate:
//   pass      → promote draft→active + FSRS enroll
//   needs_review / fail → stay draft (never reaches the pool)
//
// The copy_safety axis is separate from `overall` because the handler also folds
// a DETERMINISTIC normalized n-gram overlap into the persisted copy_safety
// verdict; the LLM's copy_safety verdict here is the model's independent read,
// and `'too_close'` blocks promotion even when the other two checks pass.

export const QuizVerifyCheckVerdict = z.enum(['pass', 'fail', 'unclear']);
export type QuizVerifyCheckVerdictT = z.infer<typeof QuizVerifyCheckVerdict>;

export const QuizVerifyCheck = z.object({
  verdict: QuizVerifyCheckVerdict,
  note: z.string().max(500).optional(),
});
export type QuizVerifyCheckT = z.infer<typeof QuizVerifyCheck>;

// copy_safety axis the LLM reports. Reuses the persisted-metadata verdict enum
// (original|too_close|unknown); max_overlap is the model's rough estimate (the
// handler may override it with its deterministic n-gram computation).
export const QuizVerifyCopySafety = z.object({
  verdict: QuizGenCopySafetyVerdict,
  max_overlap: z.number().min(0).max(1).optional(),
});
export type QuizVerifyCopySafetyT = z.infer<typeof QuizVerifyCopySafety>;

export const QuizVerificationResult = z.object({
  // §5 three checks.
  grounding: QuizVerifyCheck, // fact / grounding vs the self-reported source_refs
  copy_safety: QuizVerifyCopySafety, // plagiarism / originality vs source snippets
  knowledge_hit: QuizVerifyCheck, // does the question actually test its knowledge_ids
  // YUK-224 (slice 3, tier 3 'material_grounded') — material-grounding verdict axis.
  // OPTIONAL + additive: the verifier only emits it when the input carries a
  // `material` block (tier-3 questions). Older verifier outputs (no material) omit
  // it and still parse. Distinct from `grounding`: `grounding` asks "is the question
  // factually supported by source_refs"; this asks "does the question actually PROBE
  // the persisted material passage" (spec §6.1 row 3 真原文判据). The tier-3 gate
  // consumes THIS verdict instead of merely checking the material row is non-empty,
  // so an irrelevant-but-present material can no longer promote a question.
  material_grounding: QuizVerifyCheck.optional(),
  // Roll-up verdict driving the Option-B gate.
  overall: z.enum(['pass', 'needs_review', 'fail']),
  summary_md: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
});
export type QuizVerificationResultT = z.infer<typeof QuizVerificationResult>;
