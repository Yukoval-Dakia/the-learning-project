// B1 four-engine soft-track inc-1 (YUK-348) — KT estimate nightly job db tests.
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。
//
// 验证候选预筛（硬轨行存在 + 非 draft + 有非空作答序列）+ 逐题 estimateBkt → applyKtEstimate
// 落 kt_json + 单题失败隔离 + 计数正确。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event, item_calibration, question } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { resetDb } from '../../../../tests/helpers/db';
import { runKtEstimateNightly } from './kt_estimate_nightly';

const NOW = new Date('2026-06-16T04:55:00+08:00');

async function seedQuestion(id: string, opts: { draftStatus?: string } = {}) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    draft_status: opts.draftStatus ?? null,
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function seedHardCalibration(questionId: string) {
  await applyItemPrior(db, {
    questionId,
    draft: { b_logit: 0.5, confidence: 0.5, reasoning: 'x' },
  });
}

/** Seed an attempt event with the given binary outcome for a question. */
async function seedAttemptEvent(
  questionId: string,
  outcome: 'success' | 'failure' | 'partial' | null,
  createdAt: Date,
) {
  await db.insert(event).values({
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome,
    payload: {},
    created_at: createdAt,
  });
}

async function readKtJson(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(eq(item_calibration.question_id, questionId));
  return rows[0]?.kt_json ?? null;
}

describe('runKtEstimateNightly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('estimates kt_json for a hard-track question with an outcome sequence', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    await seedAttemptEvent(q, 'success', new Date('2026-06-15T12:00:00+08:00'));

    const result = await runKtEstimateNightly(db);

    expect(result.considered).toBe(1);
    expect(result.estimated).toBe(1);
    const kt = (await readKtJson(q)) as Record<string, unknown> | null;
    expect(kt).not.toBeNull();
    // BKT estimate shape persisted (n folds the 3 outcomes).
    expect(kt?.n).toBe(3);
    expect(typeof kt?.pLFinal).toBe('number');
    expect(typeof kt?.pL0).toBe('number');
  });

  it('excludes a question with NO outcome sequence (no-sequence prefilter)', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    // No attempt events at all.

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0);
    expect(await readKtJson(q)).toBeNull();
  });

  it('excludes a question whose only events are partial / null outcomes (non-binary)', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    await seedAttemptEvent(q, 'partial', new Date('2026-06-15T10:00:00+08:00'));
    await seedAttemptEvent(q, null, new Date('2026-06-15T11:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0); // partial/null are not binary → no candidate.
    expect(await readKtJson(q)).toBeNull();
  });

  it('excludes a draft question even with a valid outcome sequence (G5)', async () => {
    const q = createId();
    await seedQuestion(q, { draftStatus: 'draft' });
    await seedHardCalibration(q);
    await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0);
    expect(await readKtJson(q)).toBeNull();
  });

  it('excludes a question with a sequence but NO hard-track item_calibration row', async () => {
    const q = createId();
    await seedQuestion(q);
    // No applyItemPrior → no hard-track row.
    await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0); // INNER JOIN item_calibration filters it.
  });

  it('only consumes binary outcomes, skipping interleaved partial/null events', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedAttemptEvent(q, 'partial', new Date('2026-06-15T10:30:00+08:00')); // ignored
    await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    await seedAttemptEvent(q, null, new Date('2026-06-15T11:30:00+08:00')); // ignored

    const result = await runKtEstimateNightly(db);
    expect(result.estimated).toBe(1);
    const kt = (await readKtJson(q)) as Record<string, unknown> | null;
    expect(kt?.n).toBe(2); // only the 2 binary outcomes folded.
  });

  it('estimates all healthy candidates (multi-candidate happy path)', async () => {
    const good1 = createId();
    const good2 = createId();
    for (const q of [good1, good2]) {
      await seedQuestion(q);
      await seedHardCalibration(q);
      await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
      await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    }

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(2);
    expect(result.estimated).toBe(2);
    expect(result.skipped_failed).toBe(0);
    expect(await readKtJson(good1)).not.toBeNull();
    expect(await readKtJson(good2)).not.toBeNull();
  });

  it('isolates a per-question failure: throw on one write is caught, others still estimate', async () => {
    // Two healthy candidates. Monkeypatch db.update so the FIRST write throws
    // (simulated transient write fault), exercising the per-question try/catch.
    // The run must continue: one skipped_failed + one estimated, never aborting.
    const good1 = createId();
    const good2 = createId();
    for (const q of [good1, good2]) {
      await seedQuestion(q);
      await seedHardCalibration(q);
      await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
      await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    }

    const originalUpdate = db.update.bind(db);
    let calls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test monkeypatch of the query builder.
    (db as unknown as { update: any }).update = (table: unknown) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('simulated write fault');
      }
      return originalUpdate(table as never);
    };

    try {
      const result = await runKtEstimateNightly(db);
      expect(result.considered).toBe(2);
      expect(result.skipped_failed).toBe(1); // first write threw, swallowed.
      expect(result.estimated).toBe(1); // second write succeeded.
    } finally {
      (db as unknown as { update: typeof originalUpdate }).update = originalUpdate;
    }
  });
});
