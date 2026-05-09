import { z } from 'zod';
import * as b from './business';
import * as g from './generated';

export * from './business';

// ---------- Knowledge ----------
export const KnowledgeInsert = g.KnowledgeInsertGenerated.extend({
  approval_status: z.enum(['pending', 'approved', 'rejected']).default('approved'),
});
export const Knowledge = g.KnowledgeSelectGenerated.extend({
  approval_status: z.enum(['pending', 'approved', 'rejected']),
});
export type Knowledge = z.infer<typeof Knowledge>;

// ---------- Source ----------
export const SourceAssetInsert = g.SourceAssetInsertGenerated.extend({ kind: b.SourceAssetKind });
export const SourceAsset = g.SourceAssetSelectGenerated.extend({ kind: b.SourceAssetKind });
export type SourceAssetInsert = z.infer<typeof SourceAssetInsert>;
export type SourceAsset = z.infer<typeof SourceAsset>;

// ---------- Question ----------
export const QuestionInsert = g.QuestionInsertGenerated.extend({
  kind: b.QuestionKind,
  source: b.QuestionSource,
  rubric_json: b.Rubric.nullish(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullish(),
  draft_status: z.enum(['draft', 'active']).nullish(),
});
export const Question = g.QuestionSelectGenerated.extend({
  kind: b.QuestionKind,
  source: b.QuestionSource,
  rubric_json: b.Rubric.nullable(),
  visual_complexity: z.enum(['low', 'medium', 'high']).nullable(),
});
export type Question = z.infer<typeof Question>;

// ---------- Mistake ----------
export const MistakeInsert = g.MistakeInsertGenerated.extend({
  source: b.MistakeSource,
  cause: b.Cause.nullish(),
  fsrs_state: b.FsrsState.nullish(),
  variants: z.array(b.MistakeVariant).nullish(),
  status: b.MistakeStatus.nullish(),
  archived_reason: z.enum(['mastered', 'obsolete', 'user']).nullish(),
  delete_reason: z.enum(['user', 'merge', 'duplicate', 'misjudged']).nullish(),
});
export const Mistake = g.MistakeSelectGenerated.extend({
  source: b.MistakeSource,
  cause: b.Cause.nullable(),
  fsrs_state: b.FsrsState.nullable(),
  variants: z.array(b.MistakeVariant),
  status: b.MistakeStatus,
  archived_reason: z.enum(['mastered', 'obsolete', 'user']).nullable(),
  delete_reason: z.enum(['user', 'merge', 'duplicate', 'misjudged']).nullable(),
});
export type Mistake = z.infer<typeof Mistake>;

// ---------- LearningItem ----------
export const LearningItemInsert = g.LearningItemInsertGenerated.extend({
  source: b.LearningItemSource,
  status: b.LearningItemStatus.nullish(),
  archived_reason: z.enum(['maintenance', 'user']).nullish(),
});
export const LearningItem = g.LearningItemSelectGenerated.extend({
  source: b.LearningItemSource,
  status: b.LearningItemStatus,
  archived_reason: z.enum(['maintenance', 'user']).nullable(),
});
export type LearningItem = z.infer<typeof LearningItem>;

// ---------- StudyLog ----------
export const StudyLog = g.StudyLogSelectGenerated.extend({
  kind: b.StudyLogKind,
});
export type StudyLog = z.infer<typeof StudyLog>;

// ---------- Artifact ----------
export const Artifact = g.ArtifactSelectGenerated.extend({
  type: b.ArtifactType,
  intent_source: z.enum(['declared', 'from_mistake', 'from_dream']),
  sections: z.array(b.NoteSection).nullable(),
  tool_state: b.ToolState.nullable(),
  tool_kind: z.enum(['quiz']).nullable(),
  generation_status: z.enum(['pending', 'partial', 'complete']),
});
export type Artifact = z.infer<typeof Artifact>;

// ---------- Quiz 子系统 ----------
export const Answer = g.AnswerSelectGenerated.extend({
  input_kind: z.enum(['text', 'option', 'image', 'voice']),
});
export type Answer = z.infer<typeof Answer>;

export const Judgment = g.JudgmentSelectGenerated.extend({
  judge_kind: b.JudgeKind,
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  triggered_by: z.enum(['initial', 'borderline', 'appeal', 'force']).nullable(),
});
export type Judgment = z.infer<typeof Judgment>;

export const UserAppealInsert = g.UserAppealInsertGenerated;
export const UserAppeal = g.UserAppealSelectGenerated;
export type UserAppeal = z.infer<typeof UserAppeal>;

// ---------- LearningItem 完成证据 ----------
export const CompletionEvidenceInsert = g.CompletionEvidenceInsertGenerated.extend({
  path: z.enum(['self_declare', 'ai_propose', 'quiz_pass']),
});
export const CompletionEvidence = g.CompletionEvidenceSelectGenerated.extend({
  path: z.enum(['self_declare', 'ai_propose', 'quiz_pass']),
});
export type CompletionEvidence = z.infer<typeof CompletionEvidence>;

// ---------- Dreaming ----------
export const DreamingProposalInsert = g.DreamingProposalInsertGenerated.extend({
  kind: b.DreamingProposalKind,
  status: z.enum(['pending', 'accepted', 'dismissed', 'stale']).nullish(),
});
export const DreamingProposal = g.DreamingProposalSelectGenerated.extend({
  kind: b.DreamingProposalKind,
  status: z.enum(['pending', 'accepted', 'dismissed', 'stale']),
});
export type DreamingProposal = z.infer<typeof DreamingProposal>;

// ---------- 观测 ----------
export const ToolCallLogInsert = g.ToolCallLogInsertGenerated;
export const ToolCallLog = g.ToolCallLogSelectGenerated;
export type ToolCallLog = z.infer<typeof ToolCallLog>;

export const CostLedgerInsert = g.CostLedgerInsertGenerated;
export const CostLedger = g.CostLedgerSelectGenerated;
export type CostLedger = z.infer<typeof CostLedger>;
