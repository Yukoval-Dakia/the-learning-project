import { describe, expect, it } from 'vitest';
import { CauseCategory, KnowledgeInsert, Mistake } from './index';

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
});
