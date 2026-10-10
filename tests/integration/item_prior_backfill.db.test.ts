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

async function seedQuestion(id: string, knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
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
});
