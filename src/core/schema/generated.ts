// 由 drizzle-zod 从 src/db/schema.ts 自动生成。
// 改字段请改 src/db/schema.ts，不要在这里手写。
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import * as t from '../../db/schema';

export const KnowledgeInsertGenerated = createInsertSchema(t.knowledge);
export const KnowledgeSelectGenerated = createSelectSchema(t.knowledge);

export const QuestionInsertGenerated = createInsertSchema(t.question);
export const QuestionSelectGenerated = createSelectSchema(t.question);

export const MistakeInsertGenerated = createInsertSchema(t.mistake);
export const MistakeSelectGenerated = createSelectSchema(t.mistake);

export const LearningItemInsertGenerated = createInsertSchema(t.learning_item);
export const LearningItemSelectGenerated = createSelectSchema(t.learning_item);

export const StudyLogInsertGenerated = createInsertSchema(t.study_log);
export const StudyLogSelectGenerated = createSelectSchema(t.study_log);

export const ArtifactInsertGenerated = createInsertSchema(t.artifact);
export const ArtifactSelectGenerated = createSelectSchema(t.artifact);

export const AnswerInsertGenerated = createInsertSchema(t.answer);
export const AnswerSelectGenerated = createSelectSchema(t.answer);

export const JudgmentInsertGenerated = createInsertSchema(t.judgment);
export const JudgmentSelectGenerated = createSelectSchema(t.judgment);

export const UserAppealInsertGenerated = createInsertSchema(t.user_appeal);
export const UserAppealSelectGenerated = createSelectSchema(t.user_appeal);

export const CompletionEvidenceInsertGenerated = createInsertSchema(t.completion_evidence);
export const CompletionEvidenceSelectGenerated = createSelectSchema(t.completion_evidence);

export const DreamingProposalInsertGenerated = createInsertSchema(t.dreaming_proposal);
export const DreamingProposalSelectGenerated = createSelectSchema(t.dreaming_proposal);

export const ToolCallLogInsertGenerated = createInsertSchema(t.tool_call_log);
export const ToolCallLogSelectGenerated = createSelectSchema(t.tool_call_log);

export const CostLedgerInsertGenerated = createInsertSchema(t.cost_ledger);
export const CostLedgerSelectGenerated = createSelectSchema(t.cost_ledger);
