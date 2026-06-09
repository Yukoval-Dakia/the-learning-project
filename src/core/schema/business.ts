import { z } from 'zod';
import { CauseCategory } from './cause';
export {
  CauseCategory,
  CauseCategoryId,
  CauseSchema,
  getAllowedCauseIds,
  getCauseLabel,
  getCausePriority,
  validateCauseAgainstProfile,
} from './cause';
export type { CauseCategoryT, CauseSchemaT } from './cause';

// ---------- 业务 enum ----------

export const QuestionKind = z.enum([
  'choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'computation',
  'reading',
  'translation',
  // M2.1 (2026-05-22): math derivation — vision-aware steps@1 judge target.
  // See docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md §7.
  'derivation',
]);

export const QuestionSource = z.enum([
  'embedded',
  'daily',
  'final',
  'dreaming',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
  'mistake_variant',
  'teaching_check',
  // Search-grounded QuizGen wave (docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
  // §2). Zod-enum addition only — no DDL ALTER (the question.source column is text).
  'quiz_gen',
  // YUK-216 S2 (题源扩展 Strategy D) — tier 2 "sourced" questions fetched from
  // the web by SourcingTask. Zero-DDL Zod-enum addition (same手法 as 'quiz_gen'
  // above; question.source is a text column). provenance lives in
  // metadata.web_sourced (see src/core/schema/provenance.ts WebSourcedProvenance).
  // docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §2.1.
  'web_sourced',
  // ADR-0031 / YUK-304 (quiz C→A, lane B) — copilot-authored draft question
  // (author_question seed_mode='knowledge'|'material' → QuestionAuthorTask →
  // question_draft proposal; accept promotes draft→active). Zero-DDL Zod-enum
  // addition (same手法 as 'quiz_gen'/'web_sourced'; question.source is text).
  'copilot_authored',
]);

export const MistakeSource = z.enum([
  'quiz_answer',
  'manual',
  'vision_single',
  'vision_paper',
  'reverse_mark',
]);

export const MistakeStatus = z.enum(['draft', 'active', 'resting', 'archived']);

export const LearningItemSource = z.enum(['mistake', 'manual', 'learning_intent', 'ai_dream']);

export const LearningItemStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'dismissed',
  'resting',
  'archived',
]);

export const LearningRecordKind = z.enum([
  'mistake',
  'worked_example',
  'open_question',
  'insight',
  'reflection',
  'observation',
  'resource_note',
]);

export const LearningRecordSource = z.enum(['manual', 'ocr', 'import', 'conversation', 'agent']);

export const LearningRecordCaptureMode = z.enum([
  'text',
  'image',
  'paper',
  'voice',
  'url',
  'mixed',
]);

export const LearningRecordActivityKind = z.enum([
  'attempt',
  'review',
  'read',
  'ask',
  'annotate',
  'import',
  'conversation',
  'plan',
]);

export const LearningRecordProcessingStatus = z.enum(['raw', 'linked', 'actioned', 'archived']);

export const MemoryBriefScopeKey = z.string().regex(/^(global|subject:[a-zA-Z0-9_-]+)$/);

// ADR-0033 D1 (YUK-306) — 'interactive': agent-generated interactive content
// (Claude Artifacts pattern). Semantic kind; format lives in attrs (html for
// now). Self-contained + OPAQUE to the note block-tree mesh — body_blocks stays
// null (tool_quiz precedent), no cross_link/embedded_check participation.
// Reference, not practice: no FSRS / tool_state. Pure additive enum, no DDL
// (artifact.type is a text column).
export const ArtifactType = z.enum([
  'note_hub',
  'note_atomic',
  'note_long',
  'tool_quiz',
  'interactive',
]);
export const ArtifactGenerationStatus = z.enum(['pending', 'ready', 'failed']);
export type ArtifactGenerationStatusT = z.infer<typeof ArtifactGenerationStatus>;

export const ArtifactVerificationStatus = z.enum([
  'not_required',
  'not_started',
  'queued',
  'verified',
  'needs_review',
  'failed',
]);
export type ArtifactVerificationStatusT = z.infer<typeof ArtifactVerificationStatus>;

export const ArtifactEmbeddedCheckStatus = z.enum(['not_required', 'pending', 'ready', 'failed']);
export type ArtifactEmbeddedCheckStatusT = z.infer<typeof ArtifactEmbeddedCheckStatus>;

export const SourceAssetKind = z.enum(['image', 'pdf', 'text', 'web']);

export const IngestionSessionStatus = z.enum([
  'uploaded',
  'queued',
  'extracting',
  'extracted',
  'partial',
  'reviewed',
  'imported',
  'failed',
]);

// YUK-258: 'docx' entrypoint. The VISUAL line reuses initiateUpload+enqueueExtraction
// with this entrypoint (page images feed tencent_ocr_extract); the TEXT line uses
// the dedicated docx-ingestion owner and never reaches initiateUpload.
export const IngestionEntrypoint = z.enum(['vision_single', 'vision_paper', 'docx']);

// T-OC A2 (YUK-164, D1=C): `auto_enrolled` is a terminal-but-revertible state
// distinct from human `imported` — set by the WorkflowJudge enroll path
// (generated_by='workflow_judge'), revertible back to `draft` via OC-5.
// draft → imported (human) | ignored (dismiss) | auto_enrolled (AI); auto_enrolled → draft (revert).
export const QuestionBlockStatus = z.enum(['draft', 'imported', 'ignored', 'auto_enrolled']);

export const QuestionBlockRole = z.enum(['prompt', 'answer_area', 'continuation']);

export const VisualComplexity = z.enum(['low', 'medium', 'high']);

export const JudgeKind = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'unit_dimension',
  'multimodal_direct',
  'ai_flexible',
]);

export const DreamingProposalKind = z.enum([
  'problem',
  'knowledge',
  'quiz',
  'summary',
  'note_section_update',
  'learning_item_completion',
  'learning_item_relearn',
]);

// ---------- JSON 内层 schema ----------

// M2.2 (2026-05-22): reference_solution for steps@1 judge.
// expected_signals: 步骤应当体现的核心信号；final_answer: 标答；
// answer_equivalents: 学生打字提交时加速比对的等价表达。
// See src/core/capability/judges/steps.ts (StepsReferenceSolution).
export const RubricReferenceSolution = z.object({
  expected_signals: z.array(z.string().min(1)).min(1),
  final_answer: z.string().min(1),
  answer_equivalents: z.array(z.string().min(1)).default([]),
});
export type RubricReferenceSolutionT = z.infer<typeof RubricReferenceSolution>;

export const Rubric = z.object({
  criteria: z.array(
    z.object({
      name: z.string(),
      weight: z.number(),
      descriptor: z.string(),
    }),
  ),
  keywords: z.array(z.string().min(1)).optional(),
  acceptable_answers: z.array(z.string().min(1)).optional(),
  required_points: z.array(z.string().min(1)).optional(),
  reference_solution: RubricReferenceSolution.optional(),
});

export const Cause = z.object({
  primary_category: CauseCategory,
  secondary_categories: z.array(CauseCategory).default([]),
  ai_analysis_md: z.string(),
  user_notes: z.string().nullish(),
  partial: z.boolean().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  user_edited: z.boolean().default(false),
});

export const FsrsRating = z.enum(['again', 'hard', 'good']);
export const FsrsCardState = z.enum(['new', 'learning', 'review', 'relearning']);

// Mirrors ts-fsrs v5 Card. JSON column reads must FsrsState.parse() to coerce
// ISO strings back to Date — z.coerce.date() handles that.
// elapsed_days is deprecated in ts-fsrs v6 — kept optional for forward compat.
export const FsrsState = z.object({
  due: z.coerce.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number().optional(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: FsrsCardState,
  last_review: z.coerce.date().nullable(),
});

export const MistakeVariant = z.object({
  question_id: z.string(),
  status: z.enum(['draft', 'active', 'broken', 'dismissed']),
  failure_reasons: z.array(z.string()).default([]),
});

export const NoteSection = z.object({
  id: z.string(),
  kind: z.enum(['definition', 'mechanism', 'example', 'pitfall', 'check']),
  body_md: z.string(),
  source_tier: z.enum(['llm_only', 'search_grounded', 'textbook', 'user_verified']),
  user_verified: z.boolean().default(false),
  embedded_check: z.object({ question_ids: z.array(z.string()) }).nullish(),
  version: z.number().int().nonnegative(),
});

export const TipTapMarkJson = z
  .object({
    type: z.string().min(1),
    attrs: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const TipTapNodeJson: z.ZodType<Record<string, unknown>> = z
  .object({
    type: z.string().min(1),
    attrs: z.record(z.unknown()).optional(),
    content: z.array(z.lazy(() => TipTapNodeJson)).optional(),
    marks: z.array(TipTapMarkJson).optional(),
    text: z.string().optional(),
  })
  .passthrough();

export const ArtifactBodyBlocks = z
  .object({
    type: z.literal('doc'),
    content: z.array(TipTapNodeJson).default([]),
  })
  .passthrough();
export type ArtifactBodyBlocksT = z.infer<typeof ArtifactBodyBlocks>;

export const NoteVerificationIssue = z.object({
  block_id: z.string().nullable(),
  severity: z.enum(['info', 'warn', 'error']),
  category: z.enum(['factuality', 'coverage', 'clarity', 'subject_fit', 'format', 'safety']),
  message: z.string().min(1),
  suggested_fix_md: z.string().min(1).optional(),
});
export type NoteVerificationIssueT = z.infer<typeof NoteVerificationIssue>;

export const NoteVerificationResult = z.object({
  verdict: z.enum(['pass', 'needs_review']),
  summary_md: z.string().min(1).max(1000),
  issues: z.array(NoteVerificationIssue).max(10),
  confidence: z.number().min(0).max(1),
});
export type NoteVerificationResultT = z.infer<typeof NoteVerificationResult>;

// YUK-17 / ADR-0018 — VariantVerifyTask second-pass output.
// Used by `runVariantVerify` to decide whether to flip
// `mistake_variant.status` from 'active' to 'broken'.
export const VariantVerificationResult = z.object({
  verdict: z.enum(['pass', 'fail']),
  failure_reasons: z.array(z.string().min(1).max(500)).max(10).default([]),
  cause_targeting: z.enum(['on_target', 'off_target', 'unclear']),
  summary_md: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
});
export type VariantVerificationResultT = z.infer<typeof VariantVerificationResult>;

// ---------- ToolState (tool_quiz artifact.tool_state) ----------
//
// U5 (YUK-203) ToolStateT v2 — additive `sections?` variant promoted to a
// first-class shape (CO §5.1). NOT a discriminatedUnion('version'): the flat
// `question_ids[]` form must coexist on the SAME artifact for embedded_check +
// legacy quizzes, so a discriminator would break back-compat over the artifact
// scan window. `sections?` optional is purely additive — every existing flat
// quiz row (and every U4 row whose plan lives in `session_meta`) still parses
// with `sections === undefined`.
//
// RL4: tool_state is jsonb, opaque to `pnpm audit:schema`. The load-bearing
// guard is the Zod parse barrier exercised at every write point (write_review_
// plan + the U5 paper submit/adaptation paths); Artifact.parse() referencing
// this schema is defense-in-depth on read.

export const ToolStateAssignment = z.object({
  question_id: z.string(),
  // StructuredQuestion.id of the part this assignment targets (CO §2.2);
  // null/undefined for atomic questions (the whole question is one slot).
  part_ref: z.string().optional(),
  primary_knowledge_id: z.string(),
  secondary_knowledge_ids: z.array(z.string()).default([]),
  selection_reason: z.string(),
  // Snapshot blob of the review profile state at selection time. Narrow later
  // once the shape stabilizes (CO §5.1); kept open so producers don't fork the
  // schema per snapshot key.
  review_profile_snapshot: z.record(z.unknown()),
});
export type ToolStateAssignmentT = z.infer<typeof ToolStateAssignment>;

export const ToolStateSection = z.object({
  knowledge_focus: z.array(z.string()),
  // Free string at the schema layer (may carry other section-policy hints).
  // The U5 paper submit handler treats EXACTLY 'judge_now_show_later' as the
  // visible_to_user:false trigger (judge runs now, feedback buffered until the
  // paper completes); every other value (incl. the default 'immediate' / unset)
  // → immediate-visible. See app/api/practice/.../submit handler (§4.6 critic #5).
  feedback_policy: z.string(),
  adaptation_policy: z.string(),
  assignments: z.array(ToolStateAssignment),
});
export type ToolStateSectionT = z.infer<typeof ToolStateSection>;

export const ToolState = z.object({
  question_ids: z.array(z.string()),
  session_meta: z.record(z.unknown()).nullish(),
  // U5 v2 — promoted first-class structured plan. Optional → back-compat.
  sections: z.array(ToolStateSection).optional(),
});
export type ToolStateT = z.infer<typeof ToolState>;

// ADR-0033 D2/D6 (YUK-306) — the html size cap enforced at the author_artifact /
// update_artifact tool input boundary. Generous: a self-contained interactive
// page (inline CSS + JS) the copilot writes in one tool call; hard limit only
// guards against pathological inputs, not normal heavy use (护栏两层语义).
export const INTERACTIVE_HTML_MAX_CHARS = 500_000;

// ADR-0033 D2 (YUK-306) — interactive artifact payload, stored in artifact.attrs
// (existing jsonb column; NO new column, audit:schema untouched). Like ToolState
// (RL4 above), the jsonb is opaque to audit:schema — this Zod parse at every
// write point is the load-bearing barrier. Opaque to the note block-tree mesh:
// body_blocks stays null (tool_quiz precedent), the HTML source lives here.
// Deliberately NO HTML sanitizer/linter: the render-side sandbox owns security
// (ADR-0033 D4) — the backend stores the source opaquely.
export const InteractiveArtifactAttrs = z
  .object({
    // ADR-0033 D1: semantic kind 'interactive', format=html for now.
    // Future formats widen this literal into an enum.
    format: z.literal('html'),
    // Size cap is enforced at the tool input boundary (INTERACTIVE_HTML_MAX_CHARS).
    html: z.string().min(1),
    summary: z.string().max(500).optional(),
    origin: z.string().optional(), // 'copilot_author_artifact'
  })
  .catchall(z.unknown());
export type InteractiveArtifactAttrsT = z.infer<typeof InteractiveArtifactAttrs>;

// AgentRef: a uniform "who did this" stamp on question.created_by /
// judgment.judged_by / artifact.generated_by. Catchall allows callers to add
// task-specific fields without bumping the schema; required keys are the
// minimum any consumer can rely on.
export const AgentRef = z
  .object({
    by: z.enum(['ai', 'user', 'system']),
    task_kind: z.string().optional(),
    model: z.string().optional(),
    task_run_id: z.string().optional(),
  })
  .catchall(z.unknown());

// ArtifactHistoryEntry: one entry in artifact.history. Keeps the snapshot
// shape open (artifacts have many sub-kinds) but pins the bookkeeping fields
// so callers can rely on `version` + `at` to render a timeline.
export const ArtifactHistoryEntry = z
  .object({
    version: z.number().int().nonnegative(),
    at: z.coerce.date(),
    by: AgentRef.optional(),
    summary_md: z.string().optional(),
  })
  .catchall(z.unknown());
export type ArtifactHistoryEntryT = z.infer<typeof ArtifactHistoryEntry>;

// Provenance: lineage of an asset / document — minimal pinned fields, rest
// open. Source-specific fields (ocr_engine, http_status, etc.) live in the
// catchall so we don't fork the schema per source kind.
export const Provenance = z
  .object({
    captured_at: z.coerce.date().optional(),
    captured_by: AgentRef.optional(),
    source_kind: z.string().optional(),
  })
  .catchall(z.unknown());
