import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import {
  question_answer_anchor,
  question_generation_binding,
  question_generation_plan,
} from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  bindGeneratedQuestion,
  markQuestionGenerationFailed,
  prepareQuestionGeneration,
} from './question-generation-grounding';

// '北京' is 6 UTF-8 bytes; the locator is a HALF-OPEN [0, 6) byte range.
const authoritativeBytes = new TextEncoder().encode('北京');
const source = {
  artifact_kind: 'source_document',
  artifact_id: 'doc_1',
  version: 3,
  content_hash: 'sha256:doc-v3',
  locator: { kind: 'text_span' as const, start: 0, end: 6, exact_text: '北京' },
};

const baseInput = {
  source,
  authoritativeBytes,
  canonicalAnswer: { kind: 'text', value: '北京' } as const,
  anchorProvenance: { kind: 'ai_extracted' as const, task_run_id: 'anchor_run' },
  demand: { kind: 'knowledge', ref_id: 'k_1' },
  knowledgeIds: ['k_1'],
  requestedKind: 'fill_blank',
  requestedAnswerClass: 'exact',
  constraints: {},
  planProvenance: { kind: 'ai_planned' as const, task_run_id: 'plan_run' },
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

    const result = await prepareQuestionGeneration(db, { ...baseInput, generate });

    expect(result.generated).toBe('generated');
    expect(generate).toHaveBeenCalledOnce();
    const [plan] = await db.select().from(question_generation_plan);
    expect(plan?.answer_anchor_id).toBe(result.anchor.id);
    expect(plan?.answer_anchor_version).toBe(result.anchor.version);
    expect(plan?.answer_anchor_hash).toBe(result.anchor.content_hash);
    expect(plan?.status).toBe('pending_generation');
  });

  it('binds a generated question to exact plan, anchor, and comparator-policy versions', async () => {
    await resetDb();
    const prepared = await prepareQuestionGeneration(db, {
      ...baseInput,
      generate: async () => 'generated',
    });

    const binding = await bindGeneratedQuestion(db, {
      questionId: 'q_1',
      plan: prepared.plan,
      anchor: prepared.anchor,
      generated: { kind: 'fill_blank', reference_md: '北京' },
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
    const [plan] = await db.select().from(question_generation_plan);
    expect(plan?.status).toBe('generated');
  });

  it('rejects mismatched or nonexistent persisted tuples without writing a binding', async () => {
    await resetDb();
    const prepared = await prepareQuestionGeneration(db, {
      ...baseInput,
      generate: async () => 'generated',
    });

    await expect(
      bindGeneratedQuestion(db, {
        questionId: 'q_bad',
        plan: prepared.plan,
        anchor: { ...prepared.anchor, id: 'fabricated' },
        generated: { kind: 'fill_blank', reference_md: '北京' },
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
        generated: { kind: 'fill_blank', reference_md: '北京' },
      }),
    ).rejects.toThrow(/persisted/);
    expect(await db.select().from(question_generation_binding)).toEqual([]);
  });

  it('records failed generation durably and rethrows without a binding', async () => {
    await resetDb();
    await expect(
      prepareQuestionGeneration(db, {
        ...baseInput,
        generate: async () => {
          throw new Error('model unavailable');
        },
      }),
    ).rejects.toThrow('model unavailable');

    const [plan] = await db.select().from(question_generation_plan);
    expect(plan?.status).toBe('failed');
    expect(await db.select().from(question_generation_binding)).toEqual([]);
  });

  it('never invokes generation when the locator fails validation before persistence', async () => {
    await resetDb();
    const generate = vi.fn(async () => 'generated');

    await expect(
      prepareQuestionGeneration(db, {
        ...baseInput,
        source: { ...source, locator: { ...source.locator, end: 2 } },
        generate,
      }),
    ).rejects.toThrow();

    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(question_answer_anchor)).toEqual([]);
    expect(await db.select().from(question_generation_plan)).toEqual([]);
  });

  it('fails closed (no anchor/plan, no generation) when a page locator has no authoritative bytes', async () => {
    await resetDb();
    const generate = vi.fn(async () => 'generated');

    await expect(
      prepareQuestionGeneration(db, {
        ...baseInput,
        source: {
          ...source,
          locator: {
            kind: 'page_text_span' as const,
            page_id: 'page_7',
            page_version: 2,
            page_index: 6,
            start: 0,
            end: 6,
            exact_text: '北京',
          },
        },
        authoritativeBytes: null,
        generate,
      }),
    ).rejects.toThrow(/authoritative source bytes/);

    expect(generate).not.toHaveBeenCalled();
    expect(await db.select().from(question_answer_anchor)).toEqual([]);
    expect(await db.select().from(question_generation_plan)).toEqual([]);
  });

  // Finding 3 — the transition race. A concurrent failure marker must never
  // leave a failed plan with a committed binding, and it must never be able to
  // flip a plan the binding transaction already claimed.
  describe('plan transition race (Finding 3)', () => {
    it('a failure marker that wins first forces the binding transaction to roll back entirely', async () => {
      await resetDb();
      const prepared = await prepareQuestionGeneration(db, {
        ...baseInput,
        generate: async () => 'generated',
      });

      // Failure marker wins the race first.
      await markQuestionGenerationFailed(db, prepared.plan);

      // The binding transaction now cannot commit any partial artifact.
      await expect(
        db.transaction(async (tx) => {
          await bindGeneratedQuestion(tx, {
            questionId: 'q_loser',
            plan: prepared.plan,
            anchor: prepared.anchor,
            generated: { kind: 'fill_blank', reference_md: '北京' },
          });
        }),
      ).rejects.toThrow();

      const [plan] = await db.select().from(question_generation_plan);
      expect(plan?.status).toBe('failed');
      expect(await db.select().from(question_generation_binding)).toEqual([]);
    });

    it('a binding transaction that locks first wins; the concurrent failure marker no-ops', async () => {
      await resetDb();
      const prepared = await prepareQuestionGeneration(db, {
        ...baseInput,
        generate: async () => 'generated',
      });

      let failMarker: Promise<void> | undefined;
      await db.transaction(async (tx) => {
        // FOR UPDATE lock + generated transition, all still uncommitted.
        await bindGeneratedQuestion(tx, {
          questionId: 'q_winner',
          plan: prepared.plan,
          anchor: prepared.anchor,
          generated: { kind: 'fill_blank', reference_md: '北京' },
        });
        // Concurrent failure marker on a separate connection: it must block on
        // the locked row until this transaction commits.
        failMarker = markQuestionGenerationFailed(db, prepared.plan);
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await failMarker;

      const [plan] = await db.select().from(question_generation_plan);
      expect(plan?.status).toBe('generated');
      const [binding] = await db.select().from(question_generation_binding);
      expect(binding?.question_id).toBe('q_winner');
    });
  });
});
