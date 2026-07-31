import type {
  LearningRecordKind as LearningRecordKindSchema,
  LearningRecordProcessingStatus as LearningRecordProcessingStatusSchema,
} from '@/core/schema';
import type { learning_record } from '@/db/schema';
import type { InferSelectModel } from 'drizzle-orm';
import type { z } from 'zod';

export type LearningRecordKind = z.infer<typeof LearningRecordKindSchema>;
export type LearningRecordProcessingStatus = z.infer<typeof LearningRecordProcessingStatusSchema>;

export type LearningRecordRow = InferSelectModel<typeof learning_record>;

export type LearningRecordListRow = LearningRecordRow;

export interface CreateLearningRecordInput {
  id?: string;
  kind: LearningRecordKind;
  title?: string | null;
  content_md: string;
  source: 'manual' | 'ocr' | 'import' | 'conversation' | 'agent';
  capture_mode: 'text' | 'image' | 'paper' | 'voice' | 'url' | 'mixed';
  activity_kind:
    | 'attempt'
    | 'review'
    | 'read'
    | 'ask'
    | 'annotate'
    | 'import'
    | 'conversation'
    | 'plan';
  processing_status?: LearningRecordProcessingStatus;
  origin_event_id?: string | null;
  subject_id?: string | null;
  knowledge_ids: string[];
  question_id?: string | null;
  attempt_event_id?: string | null;
  learning_item_id?: string | null;
  artifact_id?: string | null;
  source_document_id?: string | null;
  asset_refs?: string[];
  payload: Record<string, unknown>;
  create_capture_event?: boolean;
}

export interface CreateLearningRecordResult {
  record: LearningRecordRow;
  origin_event?: {
    id: string;
    action: 'experimental:record_capture';
  };
}

export interface ListLearningRecordsFilter {
  kind?: LearningRecordKind[];
  knowledge_id?: string;
  question_id?: string;
  attempt_event_id?: string;
  activity_kind?: string;
  processing_status?: LearningRecordProcessingStatus[];
  since?: Date;
  before_created_at?: Date;
  before_id?: string;
  limit?: number;
  include_archived?: boolean;
}

export interface UpdateLearningRecordPatch {
  title?: string | null;
  content_md?: string;
  knowledge_ids?: string[];
  processing_status?: LearningRecordProcessingStatus;
  question_id?: string | null;
  learning_item_id?: string | null;
  artifact_id?: string | null;
  payload?: Record<string, unknown>;
  /** Optimistic compare-and-swap version; every applied mutation increments it exactly once. */
  version: number;
}

export interface TransitionLearningRecordInput {
  expected_version: number;
  to: LearningRecordProcessingStatus;
}

export interface TransitionLearningRecordResult {
  record: LearningRecordRow;
  applied: boolean;
}
