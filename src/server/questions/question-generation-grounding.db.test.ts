import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import {
  question_answer_anchor,
  question_generation_binding,
  question_generation_plan,
} from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { bindGeneratedQuestion, prepareQuestionGeneration } from './question-generation-grounding';

const source = {
  artifact_kind: 'source_document',
  artifact_id: 'doc_1',
  version: 3,
  content_hash: 'sha256:doc-v3',
  locator: { kind: 'text_span' as const, start: 4, end: 6, exact_text: '北京' },
};

describe('question generation grounding persistence (YUK-350)', () => {
  it('persists the immutable anchor before its plan and before generation starts', async () => {
    await resetDb();
    const generate = vi.fn(async (prepared: { anchor: { id: string }; plan: { id: string } }) => {
      const anchors = await db.select().from(question_answer_anchor);
      const plans = await db.select().from(question_generation_plan);
      expect(anchors.map((row) => row.id)).toContain(prepared.anchor.id);
      expect(plans.map((row) => row.id)).toContain(prepared.plan.id);
      return 'generated';
    });

    const result = await prepareQuestionGeneration(db, {
      source,
      canonicalAnswer: { kind: 'text', value: '北京' },
      anchorProvenance: { kind: 'ai_extracted', task_run_id: 'anchor_run' },
      demand: { kind: 'knowledge', ref_id: 'k_1' },
      knowledgeIds: ['k_1'],
      requestedKind: 'fill_blank',
      requestedAnswerClass: 'exact',
      constraints: {},
      planProvenance: { kind: 'ai_planned', task_run_id: 'plan_run' },
      generate,
    });

    expect(result.generated).toBe('generated');
    expect(generate).toHaveBeenCalledOnce();
    const [plan] = await db.select().from(question_generation_plan);
    expect(plan?.answer_anchor_id).toBe(result.anchor.id);
    expect(plan?.answer_anchor_version).toBe(result.anchor.version);
    expect(plan?.answer_anchor_hash).toBe(result.anchor.content_hash);
    expect(plan?.status).toBe('generated');
  });

  it('binds a generated question to exact plan, anchor, and comparator-policy versions', async () => {
    await resetDb();
    const prepared = await prepareQuestionGeneration(db, {
      source,
      canonicalAnswer: { kind: 'text', value: '北京' },
      anchorProvenance: { kind: 'ai_extracted', task_run_id: 'anchor_run' },
      demand: { kind: 'knowledge', ref_id: 'k_1' },
      knowledgeIds: ['k_1'],
      requestedKind: 'fill_blank',
      requestedAnswerClass: 'exact',
      constraints: {},
      planProvenance: { kind: 'ai_planned', task_run_id: 'plan_run' },
      generate: async () => 'generated',
    });

    const binding = await bindGeneratedQuestion(db, {
      questionId: 'q_1',
      plan: prepared.plan,
      anchor: prepared.anchor,
    });

    const [row] = await db.select().from(question_generation_binding);
    expect(row).toMatchObject({
      question_id: 'q_1',
      plan_id: prepared.plan.id,
      plan_version: prepared.plan.version,
      plan_hash: prepared.plan.content_hash,
      answer_anchor_id: prepared.anchor.id,
      answer_anchor_version: prepared.anchor.version,
      answer_anchor_hash: prepared.anchor.content_hash,
      comparator_policy_id: 'none',
      validation_status: 'needs_review',
      structural_status: 'no_veto',
    });
    expect(binding.objective_correctness).toBe('unverified');
  });

  it('rejects mismatched or nonexistent persisted tuples without writing a binding', async () => {
    await resetDb();
    const prepared = await prepareQuestionGeneration(db, {
      source,
      canonicalAnswer: { kind: 'text', value: '北京' },
      anchorProvenance: { kind: 'ai_extracted', task_run_id: 'anchor_run' },
      demand: { kind: 'knowledge', ref_id: 'k_1' },
      knowledgeIds: ['k_1'],
      requestedKind: 'fill_blank',
      requestedAnswerClass: 'exact',
      constraints: {},
      planProvenance: { kind: 'ai_planned', task_run_id: 'plan_run' },
      generate: async () => 'generated',
    });

    await expect(
      bindGeneratedQuestion(db, {
        questionId: 'q_bad',
        plan: prepared.plan,
        anchor: { ...prepared.anchor, id: 'fabricated' },
      }),
    ).rejects.toThrow(/anchor/);
    await db
      .delete(question_generation_plan)
      .where(eq(question_generation_plan.id, prepared.plan.id));
    await expect(
      bindGeneratedQuestion(db, {
        questionId: 'q_missing',
        plan: prepared.plan,
        anchor: prepared.anchor,
      }),
    ).rejects.toThrow(/persisted/);
    expect(await db.select().from(question_generation_binding)).toEqual([]);
  });

  it('records failed generation durably and rethrows without a binding', async () => {
    await resetDb();
    await expect(
      prepareQuestionGeneration(db, {
        source,
        canonicalAnswer: { kind: 'text', value: '北京' },
        anchorProvenance: { kind: 'ai_extracted', task_run_id: 'anchor_run' },
        demand: { kind: 'knowledge', ref_id: 'k_1' },
        knowledgeIds: ['k_1'],
        requestedKind: 'fill_blank',
        requestedAnswerClass: 'exact',
        constraints: {},
        planProvenance: { kind: 'ai_planned', task_run_id: 'plan_run' },
        generate: async () => {
          throw new Error('model unavailable');
        },
      }),
    ).rejects.toThrow('model unavailable');

    const [plan] = await db.select().from(question_generation_plan);
    expect(plan?.status).toBe('failed');
    expect(await db.select().from(question_generation_binding)).toEqual([]);
  });

  it('never invokes generation when anchor or plan persistence fails', async () => {
    await resetDb();
    const generate = vi.fn(async () => 'generated');

    await expect(
      prepareQuestionGeneration(db, {
        source: { ...source, locator: { ...source.locator, end: 2 } },
        canonicalAnswer: { kind: 'text', value: '北京' },
        anchorProvenance: { kind: 'ai_extracted', task_run_id: 'anchor_run' },
        demand: { kind: 'knowledge', ref_id: 'k_1' },
        knowledgeIds: ['k_1'],
        requestedKind: 'fill_blank',
        requestedAnswerClass: 'exact',
        constraints: {},
        planProvenance: { kind: 'ai_planned', task_run_id: 'plan_run' },
        generate,
      }),
    ).rejects.toThrow();

    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(question_answer_anchor)).toEqual([]);
    expect(await db.select().from(question_generation_plan)).toEqual([]);
  });
});
