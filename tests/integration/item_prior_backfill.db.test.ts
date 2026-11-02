// B1-W1 (ADR-0035) — ItemPriorTask backfill db integration.
//
// Imports the testDb helper → MUST be a db test (NOT in fastTestInclude).
// All stubbed runTaskFn → zero token, deterministic.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runItemPriorBackfill } from '@/capabilities/practice/jobs/item_prior_backfill';
import { newId } from '@/core/ids';
import { item_calibration, knowledge, question } from '@/db/schema';
import { resetDb, testDb } from '../helpers/db';

const db = testDb();

function stubItemPriorRunTask(b = 0.7, confidence = 0.4) {
  return vi.fn(async () => ({
    text: JSON.stringify({ b_logit: b, confidence, reasoning: '认知步骤数 2 + 一个前置概念' }),
  }));
}

async function seedKnowledge(id: string) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id, name: `K-${id}`, domain: 'yuwen', created_at: now, updated_at: now, version: 0 })
    .onConflictDoNothing();
}

async function seedQuestion(id: string, knowledgeIds: string[], promptMd?: string) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: promptMd ?? `Prompt ${id}`,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function output(b: number, confidence: number) {
  return JSON.stringify({ b_logit: b, confidence, reasoning: '认知步骤数 2 + 一个前置概念' });
}

describe('runItemPriorBackfill (DB integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('skips questions that already have a hard-track calibration row (idempotent)', async () => {
    const k = createId();
    const qDone = createId();
    const qNew = createId();
    await seedKnowledge(k);
    await seedQuestion(qDone, [k]);
    await seedQuestion(qNew, [k]);
    // qDone already calibrated.
    await db.insert(item_calibration).values({
      id: newId(),
      question_id: qDone,
      b: -0.5,
      confidence: 0.9,
      track: 'hard',
      source: 'llm_prior',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const stub = stubItemPriorRunTask();
    const result = await runItemPriorBackfill(db, { runTaskFn: stub });

    // Only qNew is a candidate; default reps=3 → 3 samples for it.
    expect(result.considered).toBe(1);
    expect(result.calibrated).toBe(1);
    expect(stub).toHaveBeenCalledTimes(3);

    // qDone unchanged.
    const doneRows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, qDone));
    expect(doneRows[0].b).toBeCloseTo(-0.5, 5);
  });

  // Migrated from item-prior-durable-operation.unit.test.ts (B2④); same
  // invariants now proven against the real schema and float4 columns.

  // @invariant grading: the retained backfill settles the median of three prior estimates into the hard calibration row
  // @fails-if default reps becomes one or aggregation uses the mean; the persisted b/confidence differ
  it('settles the median of three prior estimates into the calibration row', async () => {
    const q = createId();
    await seedQuestion(q, []);
    const outputs = [output(5.3, 0.9), output(0.1, 0.2), output(0.7, 0.4)];
    const runTaskFn = vi.fn(async () => ({ text: outputs.shift() ?? '' }));

    const result = await runItemPriorBackfill(db, { runTaskFn });

    expect(result).toEqual({ considered: 1, calibrated: 1, skipped_failed: 0 });
    expect(runTaskFn).toHaveBeenCalledTimes(3);
    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'llm_prior' });
    expect(rows[0].b).toBeCloseTo(0.7, 5);
    expect(rows[0].confidence).toBeCloseTo(0.4, 5);
  });

  // @invariant grading: failed reps cannot invent anchors and one failed question never blocks the rest
  // @fails-if failed reps are defaulted into drafts or the all-failed item's error escapes its per-question catch
  it('skips only the failed question and settles the surviving medians of the rest', async () => {
    const qPartial = createId();
    const qFailed = createId();
    const qLater = createId();
    // Candidate order is unordered in SQL; key outputs by the seeded prompt.
    const marker = (id: string) => `候选题 ${id} 的题面。`;
    await seedQuestion(qPartial, [], marker(qPartial));
    await seedQuestion(qFailed, [], marker(qFailed));
    await seedQuestion(qLater, [], marker(qLater));
    const queues = new Map([
      [qPartial, ['{broken json', output(-0.4, 0.2), output(0.8, 0.6)]],
      [qLater, [output(1.2, 0.3), output(1.4, 0.5), output(1.6, 0.7)]],
    ]);
    const runTaskFn = vi.fn(async (_taskName: string, input: { prompt_md: string }) => {
      for (const [id, queue] of queues) {
        if (!input.prompt_md.includes(marker(id))) continue;
        if (id === qFailed) {
          throw new Error('connection lost after dispatch; paid outcome unknown');
        }
        return { text: queue.shift() ?? '' };
      }
      throw new Error(`unexpected candidate prompt: ${input.prompt_md}`);
    });

    const result = await runItemPriorBackfill(db, { runTaskFn });

    expect(result).toEqual({ considered: 3, calibrated: 2, skipped_failed: 1 });
    expect(
      await db.select().from(item_calibration).where(eq(item_calibration.question_id, qFailed)),
    ).toEqual([]);
    const partial = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, qPartial));
    expect(partial[0]?.b).toBeCloseTo(0.2, 5);
    expect(partial[0]?.confidence).toBeCloseTo(0.4, 5);
    const later = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, qLater));
    expect(later[0]?.b).toBeCloseTo(1.4, 5);
    expect(later[0]?.confidence).toBeCloseTo(0.5, 5);
  });
});
