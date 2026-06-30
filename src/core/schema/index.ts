import { z } from 'zod';
import * as b from './business';
import * as g from './generated';

export * from './attempt-payload';
export * from './business';
export * from './proposal';

// ---------- Knowledge ----------
export const KnowledgeInsert = g.KnowledgeInsertGenerated.extend({
  approval_status: z.enum(['pending', 'approved', 'rejected']).default('approved'),
});
export const Knowledge = g.KnowledgeSelectGenerated.extend({
  approval_status: z.enum(['pending', 'approved', 'rejected']),
});
export type Knowledge = z.infer<typeof Knowledge>;

// ---------- Misconception (YUK-454 inc-1, ADR-0036 身份层) ----------
// HAND-WRITTEN Zod (NOT drizzle-zod): the misconception identity-table skeleton
// is DORMANT in L1 (no writer, no route/job/copilotTool wiring). Soft-track red
// line (ADR-0035) + subject=view are enforced by `.strict()` in the module.
export { MisconceptionInsert, MisconceptionSchema } from './misconception';
export type { Misconception } from './misconception';
// YUK-531 (A5 S4 / ADR-0036 RT1): heterogeneous misconception edge. DORMANT until
// the promotion writer / accept route lands; endpoint×relation validity lives in
// the parallel topology gate (misconception-topology-gate.ts), not the Zod here.
export {
  CANONICAL_MISCONCEPTION_RELATIONS,
  MisconceptionEdgeInsert,
  MisconceptionEdgeKind,
  MisconceptionEdgeSchema,
  MisconceptionRelationType,
} from './misconception-edge';
export type { MisconceptionEdge } from './misconception-edge';

// ---------- Source ----------
export const SourceAssetInsert = g.SourceAssetInsertGenerated.extend({ kind: b.SourceAssetKind });
export const SourceAsset = g.SourceAssetSelectGenerated.extend({ kind: b.SourceAssetKind });
export type SourceAssetInsert = z.infer<typeof SourceAssetInsert>;
export type SourceAsset = z.infer<typeof SourceAsset>;

export const BBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type BBox = z.infer<typeof BBox>;

export const PageSpan = z.object({
  page_index: z.number().int().min(0),
  bbox: BBox,
  role: b.QuestionBlockRole.optional(),
});
export type PageSpan = z.infer<typeof PageSpan>;

// ---------- Ingestion ----------
export const SourceDocumentInsert = g.SourceDocumentInsertGenerated;
export const SourceDocument = g.SourceDocumentSelectGenerated;
export type SourceDocument = z.infer<typeof SourceDocument>;

// Phase 1c.1 Step 9.J: legacy `ingestion_session` table DROPped. Sessions now
// live in `learning_session(type='ingestion')`; Zod schemas for the new shape
// live in src/core/schema/learning_session.ts (Lane B).

export const QuestionBlockInsert = g.QuestionBlockInsertGenerated.extend({
  page_spans: z.array(PageSpan).min(1).max(8),
  status: b.QuestionBlockStatus.nullish(),
  visual_complexity: b.VisualComplexity.nullish(),
});
export const QuestionBlock = g.QuestionBlockSelectGenerated.extend({
  page_spans: z.array(PageSpan).min(1).max(8),
  status: b.QuestionBlockStatus,
  visual_complexity: b.VisualComplexity,
});
export type QuestionBlock = z.infer<typeof QuestionBlock>;

// ---------- Question ----------
export const QuestionInsert = g.QuestionInsertGenerated.extend({
  kind: b.QuestionKind,
  source: b.QuestionSource,
  rubric_json: b.Rubric.nullish(),
  choices_md: z.array(z.string()).nullish(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullish(),
  draft_status: z.enum(['draft', 'active']).nullish(),
});
export const Question = g.QuestionSelectGenerated.extend({
  kind: b.QuestionKind,
  source: b.QuestionSource,
  rubric_json: b.Rubric.nullable(),
  choices_md: z.array(z.string()).nullable(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullable(),
});
export type Question = z.infer<typeof Question>;

// Phase 1c.1 Step 9.J: legacy `mistake` + `review_event` tables DROPped.
// Failure attempts are events (action='attempt', outcome='failure'); reviews
// are events (action='review'). FSRS state projection lives in
// `material_fsrs_state`. Zod schemas for the event shapes live in
// src/core/schema/event/known.ts (Lane B).

// ---------- LearningItem ----------
// YUK-19 — `proposal_retracted` is set when a learning_intent proposal's L3
// correction tombstones the hub + atomic LearningItems it materialized. See
// `retractAiProposal()` in src/server/proposals/actions.ts.
export const LearningItemInsert = g.LearningItemInsertGenerated.extend({
  source: b.LearningItemSource,
  status: b.LearningItemStatus.nullish(),
  archived_reason: z.enum(['maintenance', 'user', 'proposal_retracted']).nullish(),
});
export const LearningItem = g.LearningItemSelectGenerated.extend({
  source: b.LearningItemSource,
  status: b.LearningItemStatus,
  archived_reason: z.enum(['maintenance', 'user', 'proposal_retracted']).nullable(),
});
export type LearningItem = z.infer<typeof LearningItem>;

// ---------- LearningRecord ----------
export const LearningRecordInsert = g.LearningRecordInsertGenerated.extend({
  kind: b.LearningRecordKind,
  source: b.LearningRecordSource,
  capture_mode: b.LearningRecordCaptureMode,
  activity_kind: b.LearningRecordActivityKind,
  processing_status: b.LearningRecordProcessingStatus.nullish(),
});
export const LearningRecord = g.LearningRecordSelectGenerated.extend({
  kind: b.LearningRecordKind,
  source: b.LearningRecordSource,
  capture_mode: b.LearningRecordCaptureMode,
  activity_kind: b.LearningRecordActivityKind,
  processing_status: b.LearningRecordProcessingStatus,
});
export type LearningRecordInsert = z.infer<typeof LearningRecordInsert>;
export type LearningRecord = z.infer<typeof LearningRecord>;

// ---------- MemoryBriefNote ----------
export const MemoryBriefNoteInsert = g.MemoryBriefNoteInsertGenerated.extend({
  scope_key: b.MemoryBriefScopeKey,
});
export const MemoryBriefNote = g.MemoryBriefNoteSelectGenerated.extend({
  scope_key: b.MemoryBriefScopeKey,
});
export type MemoryBriefNoteInsert = z.infer<typeof MemoryBriefNoteInsert>;
export type MemoryBriefNote = z.infer<typeof MemoryBriefNote>;

// ---------- Artifact ----------
export const Artifact = g.ArtifactSelectGenerated.extend({
  type: b.ArtifactType,
  // U5 (YUK-203) — widened so every paper row (Coach review_plan / quiz_gen /
  // embedded_check) parses without throwing. The three new values are the live
  // DB intent_source strings; `tool_kind` mirrors them. Pure additive enum.
  // YUK-214 (Strategy D · S1) — `ingestion_paper` is the fourth paper provenance:
  // a tool_quiz built from a session's imported questions (ingest→practice
  // bridge §2.3). Pure additive enum, no migration (intent_source/tool_kind are
  // text columns).
  // ADR-0033 D6 (YUK-306) — `author_artifact` is the interactive-artifact
  // provenance (copilot-authored via the author_artifact DomainTool; tool_kind
  // mirrors it). Pure additive enum, no migration. NOT a paper provenance —
  // practice gates (practice-read.ts / /api/practice) must keep rejecting it.
  intent_source: z.enum([
    'learning_intent',
    'declared',
    'from_mistake',
    'from_dream',
    'review_plan',
    'quiz_gen',
    'embedded_check',
    'ingestion_paper',
    'author_artifact',
  ]),
  body_blocks: b.ArtifactBodyBlocks.nullable(),
  knowledge_ids: z.array(z.string()),
  attrs: z.record(z.unknown()),
  tool_state: b.ToolState.nullable(),
  // ADR-0033 D6 (YUK-306) — 'author_artifact' mirrors the intent_source above
  // for type='interactive' rows. Pure additive enum (text column, no DDL).
  tool_kind: z
    .enum([
      'quiz',
      'review_plan',
      'quiz_gen',
      'embedded_check',
      'ingestion_paper',
      'author_artifact',
    ])
    .nullable(),
  generation_status: b.ArtifactGenerationStatus,
  verification_status: b.ArtifactVerificationStatus,
  verification_summary: b.NoteVerificationResult.nullable(),
  verified_by: b.AgentRef.nullable(),
});
export type Artifact = z.infer<typeof Artifact>;

// ---------- Quiz 子系统 ----------
export const Answer = g.AnswerSelectGenerated.extend({
  input_kind: z.enum(['text', 'option', 'image', 'voice']),
});
export type Answer = z.infer<typeof Answer>;

// Judgment + UserAppeal removed in Phase 1c.1 Step 1.4 (Lane A) per ADR-0006 v2 /
// data-assumptions §O2. Judge is now an event (action='judge', subject_kind='event').

// ---------- LearningItem 完成证据 ----------
export const CompletionEvidenceInsert = g.CompletionEvidenceInsertGenerated.extend({
  path: z.enum(['self_declare', 'ai_propose', 'quiz_pass']),
});
export const CompletionEvidence = g.CompletionEvidenceSelectGenerated.extend({
  path: z.enum(['self_declare', 'ai_propose', 'quiz_pass']),
});
export type CompletionEvidence = z.infer<typeof CompletionEvidence>;

// Phase 1c.1 Step 9.J: legacy `dreaming_proposal` table DROPped. Proposals
// live as event(action='propose', subject_kind='knowledge') (Lane B
// ProposeKnowledge) plus experimental:knowledge_<mutation> namespace events.

// ---------- 观测 ----------
export const ToolCallLogInsert = g.ToolCallLogInsertGenerated;
export const ToolCallLog = g.ToolCallLogSelectGenerated;
export type ToolCallLog = z.infer<typeof ToolCallLog>;

export const CostLedgerInsert = g.CostLedgerInsertGenerated;
export const CostLedger = g.CostLedgerSelectGenerated;
export type CostLedger = z.infer<typeof CostLedger>;
