import { event, knowledge, question } from '@/db/schema';
import { collectGroundingGateCandidates } from '@/server/grounding-gate/candidates';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

const NOW = new Date('2026-07-29T00:00:00.000Z');
const KC_ID = 'kc_grounding_gate_real';
const QUESTION_ID = 'q_grounding_gate_real';

async function seedFailure(input: {
  id: string;
  createdAt: Date;
  synthetic?: boolean;
}): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: input.id,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: QUESTION_ID,
      outcome: 'failure',
      payload: {
        answer_md: '把两层导数直接相乘。',
        answer_image_refs: [],
        referenced_knowledge_ids: [KC_ID],
        reasoning_trace: '我以为链式法则就是把每层导数相乘。',
        ...(input.synthetic ? { __synthetic: true } : {}),
      },
      created_at: input.createdAt,
    });
  await testDb()
    .insert(event)
    .values({
      id: `judge_${input.id}`,
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: input.id,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept_confusion',
          secondary_categories: [],
          analysis_md: '链式法则概念混淆。',
          confidence: 0.9,
        },
        referenced_knowledge_ids: [KC_ID],
        ...(input.synthetic ? { __synthetic: true } : {}),
      },
      caused_by_event_id: input.id,
      created_at: input.createdAt,
    });
}

describe('collectGroundingGateCandidates', () => {
  beforeEach(async () => {
    await resetDb();
    await testDb()
      .insert(knowledge)
      .values({
        id: KC_ID,
        name: '链式法则',
        domain: 'math',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
        updated_at: new Date('2026-07-01T00:00:00.000Z'),
      });
    await testDb()
      .insert(question)
      .values({
        id: QUESTION_ID,
        kind: 'short_answer',
        prompt_md: '求复合函数的导数。',
        reference_md: '先求外层导数，再乘以内层导数。',
        knowledge_ids: [KC_ID],
        difficulty: 3,
        source: 'manual',
        draft_status: 'active',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
        updated_at: new Date('2026-07-01T00:00:00.000Z'),
      });
  });

  it('reuses the production read chain while excluding synthetic evidence from the real gate', async () => {
    await seedFailure({
      id: 'attempt_real_1',
      createdAt: new Date('2026-07-28T01:00:00.000Z'),
    });
    await seedFailure({
      id: 'attempt_real_2',
      createdAt: new Date('2026-07-28T02:00:00.000Z'),
    });
    await seedFailure({
      id: 'attempt_synthetic_1',
      createdAt: new Date('2026-07-28T03:00:00.000Z'),
      synthetic: true,
    });
    const loadEvidenceImages = vi.fn(async () => []);
    const report = await collectGroundingGateCandidates(testDb(), {
      now: NOW,
      loadEvidenceImages,
    });
    expect(report.recent_failure_count).toBe(2);
    expect(report.synthetic_failure_count).toBe(1);
    expect(report.eligible_count).toBe(1);
    expect(report.candidates[0].cell).toMatchObject({
      key: `concept_confusion::${KC_ID}`,
      recurrence_count: 2,
      evidence_event_ids: ['attempt_real_2', 'attempt_real_1'],
      knowledge_name: '<untrusted_learner_text>链式法则</untrusted_learner_text>',
    });
    expect(report.candidates[0].cell.evidence_event_ids).not.toContain('attempt_synthetic_1');
    expect(loadEvidenceImages).toHaveBeenCalledTimes(1);
  });
});
