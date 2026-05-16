// Phase 1c.1 Step 9.J — schema.test trimmed: tests for dropped tables
// (Mistake / ReviewEvent / IngestionSession / DreamingProposal) removed.
// Surviving tests cover the schemas that still exist post-DROP.

import { describe, expect, it } from 'vitest';
import {
  CauseCategory,
  FsrsState,
  KnowledgeInsert,
  LearningItemInsert,
  QuestionBlock,
  QuestionBlockInsert,
  SourceAsset,
} from './index';

describe('schema generated from drizzle', () => {
  it('KnowledgeInsert accepts valid record', () => {
    const result = KnowledgeInsert.safeParse({
      id: 'k1',
      name: '宾语前置',
      domain: 'wenyan',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('CauseCategory rejects unknown category', () => {
    const result = CauseCategory.safeParse('not_a_real_category');
    expect(result.success).toBe(false);
  });

  it('LearningItemInsert accepts minimal payload', () => {
    const result = LearningItemInsert.safeParse({
      id: 'li1',
      source: 'mistake',
      title: '宾语前置',
      created_at: new Date(),
      updated_at: new Date(),
    });
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('KnowledgeInsert accepts null domain (non-root nodes inherit)', () => {
    const result = KnowledgeInsert.safeParse({
      id: 'k_child',
      name: '通假字',
      domain: null,
      parent_id: 'k_root',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('SourceAsset accepts image metadata', () => {
    const result = SourceAsset.safeParse({
      id: 'asset_1',
      kind: 'image',
      storage_key: 'images/asset_1.png',
      mime_type: 'image/png',
      byte_size: 123,
      sha256: 'a'.repeat(64),
      width: null,
      height: null,
      provenance: {},
      created_at: new Date(1700000000 * 1000),
    });
    expect(result.success).toBe(true);
  });

  it('SourceAsset rejects unknown kind', () => {
    const result = SourceAsset.safeParse({
      id: 'asset_2',
      kind: 'video',
      storage_key: 'x',
      mime_type: 'video/mp4',
      byte_size: 1,
      sha256: 'a'.repeat(64),
      width: null,
      height: null,
      provenance: {},
      created_at: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('QuestionBlock accepts a single-page draft block', () => {
    const result = QuestionBlockInsert.safeParse({
      id: 'qb_1',
      ingestion_session_id: 'sess_1',
      source_document_id: 'doc_1',
      source_asset_ids: ['asset_1'],
      page_spans: [
        { page_index: 0, bbox: { x: 0.1, y: 0.2, width: 0.6, height: 0.3 }, role: 'prompt' },
      ],
      extracted_prompt_md: '题面',
      reference_md: null,
      wrong_answer_md: null,
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 0.9,
      status: 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_mistake_id: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    expect(result.success).toBe(true);
  });

  it('QuestionBlock accepts a merged cross-page block (page_spans length 2)', () => {
    const result = QuestionBlock.safeParse({
      id: 'qb_merged',
      ingestion_session_id: 'sess_1',
      source_document_id: 'doc_1',
      source_asset_ids: ['asset_1', 'asset_2'],
      page_spans: [
        { page_index: 0, bbox: { x: 0, y: 0.7, width: 1, height: 0.3 }, role: 'continuation' },
        { page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 0.4 }, role: 'answer_area' },
      ],
      extracted_prompt_md: '跨页题面',
      structured: null,
      figures: [],
      layout_quality: 'structured',
      reference_md: null,
      wrong_answer_md: '错答',
      image_refs: ['asset_1', 'asset_2'],
      crop_refs: [],
      visual_complexity: 'medium',
      extraction_confidence: 0.8,
      status: 'imported',
      knowledge_hint: null,
      merged_from_block_ids: ['qb_1', 'qb_2'],
      imported_question_id: null,
      imported_mistake_id: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page_spans).toHaveLength(2);
      expect(result.data.merged_from_block_ids).toEqual(['qb_1', 'qb_2']);
    }
  });

  it('FsrsState accepts ts-fsrs Card-aligned shape', () => {
    const result = FsrsState.safeParse({
      due: new Date(1700000000 * 1000),
      stability: 1.5,
      difficulty: 5.0,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state: 'review',
      last_review: new Date(1700000000 * 1000 - 86_400_000),
    });
    expect(result.success).toBe(true);
  });

  it('FsrsState rejects old shape (due_at / interval / ease)', () => {
    const result = FsrsState.safeParse({
      due_at: new Date(),
      interval: 1,
      ease: 2.5,
      repeat: 1,
      lapses: 0,
    });
    expect(result.success).toBe(false);
  });

  it('FsrsState coerces ISO string due (DB JSON round-trip path)', () => {
    const result = FsrsState.safeParse({
      due: '2026-05-10T00:00:00.000Z',
      stability: 1,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state: 'learning',
      last_review: '2026-05-09T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.due).toBeInstanceOf(Date);
      expect(result.data.last_review).toBeInstanceOf(Date);
    }
  });
});
