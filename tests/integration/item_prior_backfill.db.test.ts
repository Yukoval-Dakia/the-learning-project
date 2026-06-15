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
    .values({ id, name: `K-${id}`, domain: 'wenyan', created_at: now, updated_at: now, version: 0 })
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

  it('calibrates a question with no calibration row', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    const stub = stubItemPriorRunTask(1.2, 0.5);
    const result = await runItemPriorBackfill(db, { runTaskFn: stub });

    expect(result.considered).toBe(1);
    expect(result.calibrated).toBe(1);
    expect(result.skipped_failed).toBe(0);
    expect(stub).toHaveBeenCalledTimes(1);

    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0].b).toBeCloseTo(1.2, 5);
    expect(rows[0].source).toBe('llm_prior');
    expect(rows[0].track).toBe('hard');
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

    // Only qNew is a candidate.
    expect(result.considered).toBe(1);
    expect(result.calibrated).toBe(1);
    expect(stub).toHaveBeenCalledTimes(1);

    // qDone unchanged.
    const doneRows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, qDone));
    expect(doneRows[0].b).toBeCloseTo(-0.5, 5);
  });

  it('returns considered=0 when nothing needs calibration', async () => {
    const stub = stubItemPriorRunTask();
    const result = await runItemPriorBackfill(db, { runTaskFn: stub });
    expect(result.considered).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it('skips a single bad question (LLM/parse failure) without blocking the rest', async () => {
    const k = createId();
    const qBad = createId();
    const qGood = createId();
    await seedKnowledge(k);
    await seedQuestion(qBad, [k]);
    await seedQuestion(qGood, [k]);

    // First call (whichever question) returns garbage; the rest return valid.
    let n = 0;
    const stub = vi.fn(async () => {
      n++;
      if (n === 1) return { text: 'not json at all' };
      return { text: JSON.stringify({ b_logit: 0.3, confidence: 0.4, reasoning: 'x' }) };
    });

    const result = await runItemPriorBackfill(db, { runTaskFn: stub });
    expect(result.considered).toBe(2);
    expect(result.calibrated).toBe(1);
    expect(result.skipped_failed).toBe(1);

    // The failed question's row was NOT written → it stays a candidate for the
    // next run (no partial write).
    const rows = await db.select().from(item_calibration);
    expect(rows).toHaveLength(1);
  });

  it('respects maxPerRun cap', async () => {
    const k = createId();
    await seedKnowledge(k);
    for (let i = 0; i < 5; i++) await seedQuestion(createId(), [k]);

    const stub = stubItemPriorRunTask();
    const result = await runItemPriorBackfill(db, { runTaskFn: stub, maxPerRun: 2 });
    expect(result.considered).toBe(2);
    expect(result.calibrated).toBe(2);
  });
});
