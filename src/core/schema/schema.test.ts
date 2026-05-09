import { describe, expect, it } from 'vitest';
import {
  CauseCategory,
  DreamingProposal,
  KnowledgeInsert,
  LearningItemInsert,
  Mistake,
  MistakeInsert,
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
});
