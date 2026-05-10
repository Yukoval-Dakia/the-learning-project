import { describe, expect, it } from 'vitest';
import {
  CauseCategory,
  DreamingProposal,
  FsrsState,
  IngestionSession,
  KnowledgeInsert,
  LearningItemInsert,
  Mistake,
  MistakeInsert,
  QuestionBlock,
  QuestionBlockInsert,
  ReviewEvent,
  ReviewEventInsert,
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

  it('Mistake parses with typed cause field', () => {
    const result = Mistake.safeParse({
      id: 'm1',
      question_id: 'q1',
      wrong_answer_md: null,
      wrong_answer_image_refs: [],
      source: 'manual',
      source_ref: null,
      knowledge_ids: [],
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        ai_analysis_md: '理解偏差',
        user_edited: false,
      },
      fsrs_state: null,
      variants: [],
      variants_generated_count: 0,
      variants_max: 3,
      status: 'active',
      archived_reason: null,
      archived_at: null,
      deleted_at: null,
      delete_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('MistakeInsert accepts insert payload (no timestamps required for defaulted fields)', () => {
    const result = MistakeInsert.safeParse({
      id: 'm1',
      question_id: 'q1',
      source: 'manual',
      created_at: new Date(),
      updated_at: new Date(),
    });
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
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

  it('DreamingProposal Select rejects unknown status', () => {
    const result = DreamingProposal.safeParse({
      id: 'p1',
      kind: 'quiz',
      payload: {},
      reasoning: 'x',
      status: 'bogus_status',
      proposed_at: new Date(),
      decided_at: null,
    });
    expect(result.success).toBe(false);
  });

  it('DreamingProposal accepts status=stale', () => {
    const result = DreamingProposal.safeParse({
      id: 'p1',
      kind: 'knowledge',
      payload: '{}',
      reasoning: 'r',
      status: 'stale',
      proposed_at: new Date(1700000000 * 1000),
      decided_at: new Date(1700001000 * 1000),
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
      reference_md: null,
      wrong_answer_md: '错答',
      image_refs: ['asset_1', 'asset_2'],
      crop_refs: [],
      visual_complexity: 'medium',
      extraction_confidence: 0.8,
      status: 'merged',
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

  it('IngestionSession rejects unknown status', () => {
    const result = IngestionSession.safeParse({
      id: 'sess_1',
      source_document_id: null,
      source_asset_ids: [],
      status: 'bogus',
      entrypoint: 'vision_single',
      error_message: null,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    expect(result.success).toBe(false);
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

  it('ReviewEventInsert accepts a first-review entry (before=null)', () => {
    const result = ReviewEventInsert.safeParse({
      id: 'rev_1',
      mistake_id: 'm1',
      rating: 'again',
      response_md: null,
      latency_ms: 5000,
      fsrs_state_before: null,
      fsrs_state_after: {
        due: new Date().toISOString(),
        stability: 0.4,
        difficulty: 5,
        elapsed_days: 0,
        scheduled_days: 0,
        learning_steps: 1,
        reps: 1,
        lapses: 1,
        state: 'learning',
        last_review: new Date().toISOString(),
      },
      due_at_before: null,
      due_at_next: new Date(),
      created_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('ReviewEvent rejects unknown rating', () => {
    const result = ReviewEvent.safeParse({
      id: 'rev_2',
      mistake_id: 'm1',
      rating: 'easy',
      response_md: null,
      latency_ms: null,
      fsrs_state_before: null,
      fsrs_state_after: {},
      due_at_before: null,
      due_at_next: new Date(),
      created_at: new Date(),
    });
    expect(result.success).toBe(false);
  });
});
