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

  // YUK-376 — method:'llasa' opt-in：走 ItemPriorLlasaTask + 反推 + 'llm_prior_llasa' 写源。
  it('llasa method invokes ItemPriorLlasaTask, inverts the simulation, and stamps llm_prior_llasa', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    // 模拟输出：θ=-2/-1 全错、θ=0 一对一错、θ=1/2 全对 → b̂≈0（交叉点在 0）。
    const llasaText = JSON.stringify({
      simulated_responses: [
        { theta_level: -2, student_answer_md: '猜了一个选项', correct: false, note: '完全不会' },
        { theta_level: -2, student_answer_md: '写了无关公式', correct: false, note: '概念错位' },
        { theta_level: -1, student_answer_md: '半截推导', correct: false, note: '卡在第二步' },
        { theta_level: -1, student_answer_md: '方向对终值错', correct: false, note: '计算失误' },
        { theta_level: 0, student_answer_md: '完整过程答对', correct: true, note: '常规解法' },
        { theta_level: 0, student_answer_md: '漏检查条件答错', correct: false, note: '踩隐蔽坑' },
        { theta_level: 1, student_answer_md: '正确', correct: true, note: '稳定答对' },
        { theta_level: 1, student_answer_md: '正确', correct: true, note: '稳定答对' },
        { theta_level: 2, student_answer_md: '正确并给推广', correct: true, note: '超出要求' },
        { theta_level: 2, student_answer_md: '正确', correct: true, note: '简洁正确' },
      ],
      reasoning: '分水岭在 θ=0 附近',
    });
    const stub = vi.fn(async (kind: string, input: unknown) => {
      expect(kind).toBe('ItemPriorLlasaTask');
      // llasa 输入带 reference_md/choices_md 字段位（可为 null）。
      expect(input).toHaveProperty('prompt_md');
      expect(input).toHaveProperty('reference_md');
      expect(input).toHaveProperty('choices_md');
      return { text: llasaText };
    });

    const result = await runItemPriorBackfill(db, { runTaskFn: stub, method: 'llasa' });
    expect(result.calibrated).toBe(1);

    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('llm_prior_llasa');
    expect(rows[0].track).toBe('hard');
    // 交叉点在 θ=0 → b̂≈0；confidence 是反推启发式而非 LLM 自报。
    expect(rows[0].b).toBeGreaterThan(-0.5);
    expect(rows[0].b).toBeLessThan(0.5);
    expect(rows[0].b_anchor).toBeCloseTo(rows[0].b as number, 5);
  });

  it('feature method stays the default and keeps the original input shape', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    const stub = vi.fn(async (kind: string, input: unknown) => {
      expect(kind).toBe('ItemPriorTask');
      // feature 输入不得带 llasa 新增字段（输入 hash 稳定 = 默认路径零变更）。
      expect(input).not.toHaveProperty('reference_md');
      expect(input).not.toHaveProperty('choices_md');
      return {
        text: JSON.stringify({ b_logit: 0.9, confidence: 0.4, reasoning: '特征分解' }),
      };
    });

    const result = await runItemPriorBackfill(db, { runTaskFn: stub });
    expect(result.calibrated).toBe(1);
    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows[0].source).toBe('llm_prior');
    expect(rows[0].b).toBeCloseTo(0.9, 5);
  });
});
