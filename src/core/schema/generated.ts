// 由 drizzle-zod 从 src/db/schema.ts 自动生成。
// 改字段请改 src/db/schema.ts，不要在这里手写。
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import * as t from '../../db/schema';

export const KnowledgeInsertGenerated = createInsertSchema(t.knowledge);
export const KnowledgeSelectGenerated = createSelectSchema(t.knowledge);

export const SourceAssetInsertGenerated = createInsertSchema(t.source_asset);
export const SourceAssetSelectGenerated = createSelectSchema(t.source_asset);

export const SourceDocumentInsertGenerated = createInsertSchema(t.source_document);
export const SourceDocumentSelectGenerated = createSelectSchema(t.source_document);

// Phase 1c.1 Step 9.J — ingestion_session, mistake, review_event,
// dreaming_proposal tables DROPped. Sessions live in learning_session
// (type='ingestion'); attempts / reviews / proposals live in `event`.

export const QuestionBlockInsertGenerated = createInsertSchema(t.question_block);
export const QuestionBlockSelectGenerated = createSelectSchema(t.question_block);

export const QuestionInsertGenerated = createInsertSchema(t.question);
export const QuestionSelectGenerated = createSelectSchema(t.question);

export const LearningItemInsertGenerated = createInsertSchema(t.learning_item);
export const LearningItemSelectGenerated = createSelectSchema(t.learning_item);

export const LearningRecordInsertGenerated = createInsertSchema(t.learning_record);
export const LearningRecordSelectGenerated = createSelectSchema(t.learning_record);

export const MemoryBriefNoteInsertGenerated = createInsertSchema(t.memory_brief_note);
export const MemoryBriefNoteSelectGenerated = createSelectSchema(t.memory_brief_note);

export const ArtifactInsertGenerated = createInsertSchema(t.artifact);
export const ArtifactSelectGenerated = createSelectSchema(t.artifact);

export const AnswerInsertGenerated = createInsertSchema(t.answer);
export const AnswerSelectGenerated = createSelectSchema(t.answer);

// judgment + user_appeal removed in Phase 1c.1 Step 1.4 (Lane A) per ADR-0006 v2 /
// data-assumptions §O2. Judge is now an event (action='judge', subject_kind='event').

export const CompletionEvidenceInsertGenerated = createInsertSchema(t.completion_evidence);
export const CompletionEvidenceSelectGenerated = createSelectSchema(t.completion_evidence);

export const ToolCallLogInsertGenerated = createInsertSchema(t.tool_call_log);
export const ToolCallLogSelectGenerated = createSelectSchema(t.tool_call_log);

export const CostLedgerInsertGenerated = createInsertSchema(t.cost_ledger);
export const CostLedgerSelectGenerated = createSelectSchema(t.cost_ledger);
