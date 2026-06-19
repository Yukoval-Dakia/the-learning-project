// B1 four-engine soft-track inc-1 (YUK-348) — KT estimate nightly job db tests.
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。
//
// 验证候选预筛（硬轨行存在 + 非 draft + 有**客观 judge 锚定的**非空作答序列）+ 逐题
// estimateBkt → applyKtEstimate 落 kt_json + 单题失败隔离 + 计数正确 + **客观判分门**
// （排除 FSRS-rating-derived / 手评 / LLM-judge outcome）。

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

/**
 * Seed an attempt/review event with the given outcome for a question. Returns the
 * event id so callers can attach a judge event via `seedJudgeEvent`.
 */
async function seedAttemptEvent(
  questionId: string,
  outcome: 'success' | 'failure' | 'partial' | null,
  createdAt: Date,
): Promise<string> {
  const id = newId();
  await db.insert(event).values({
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome,
    payload: {},
    created_at: createdAt,
  });
  return id;
}

/**
 * Seed an independent judge event pointing back at `attemptEventId` via
 * `caused_by_event_id`, with `payload.judge_route = route`. Mirrors the production
 * shape written by submit.ts / paper-submit.ts (actor=agent, subject_kind='event',
 * subject_id = the attempt/review event id). `route` controls objective-gate
 * outcome: 'exact' / 'keyword' anchor the attempt as an objective observation;
 * any other value (e.g. 'semantic') does not.
 */
async function seedJudgeEvent(
  attemptEventId: string,
  route: string,
  createdAt: Date,
): Promise<void> {
  await db.insert(event).values({
    id: newId(),
    actor_kind: 'agent',
    actor_ref: 'review_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: { judge_route: route },
    caused_by_event_id: attemptEventId,
    created_at: createdAt,
  });
}

/**
 * Convenience: seed an attempt event **anchored by an objective judge event**
 * (judge_route='exact'). This is the canonical "objective binary observation"
 * shape that KT estimation consumes.
 */
async function seedObjectiveAttempt(
  questionId: string,
  outcome: 'success' | 'failure',
  createdAt: Date,
): Promise<void> {
  const attemptId = await seedAttemptEvent(questionId, outcome, createdAt);
  await seedJudgeEvent(attemptId, 'exact', createdAt);
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

  it('estimates kt_json for a hard-track question with an objective outcome sequence', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedObjectiveAttempt(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T12:00:00+08:00'));

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
    // partial / null are non-binary — even if anchored by an objective judge they
    // are excluded (judge anchor only gates objectivity, not binary-ness).
    const a1 = await seedAttemptEvent(q, 'partial', new Date('2026-06-15T10:00:00+08:00'));
    await seedJudgeEvent(a1, 'exact', new Date('2026-06-15T10:00:00+08:00'));
    const a2 = await seedAttemptEvent(q, null, new Date('2026-06-15T11:00:00+08:00'));
    await seedJudgeEvent(a2, 'exact', new Date('2026-06-15T11:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0); // partial/null are not binary → no candidate.
    expect(await readKtJson(q)).toBeNull();
  });

  it('excludes a draft question even with a valid objective outcome sequence (G5)', async () => {
    const q = createId();
    await seedQuestion(q, { draftStatus: 'draft' });
    await seedHardCalibration(q);
    await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0);
    expect(await readKtJson(q)).toBeNull();
  });

  it('excludes a question with a sequence but NO hard-track item_calibration row', async () => {
    const q = createId();
    await seedQuestion(q);
    // No applyItemPrior → no hard-track row.
    await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0); // INNER JOIN item_calibration filters it.
  });

  it('only consumes binary outcomes, skipping interleaved partial/null events', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    // partial + null attempts without judge anchors — non-binary AND non-anchored.
    await seedAttemptEvent(q, 'partial', new Date('2026-06-15T10:30:00+08:00')); // ignored
    await seedObjectiveAttempt(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    await seedAttemptEvent(q, null, new Date('2026-06-15T11:30:00+08:00')); // ignored

    const result = await runKtEstimateNightly(db);
    expect(result.estimated).toBe(1);
    const kt = (await readKtJson(q)) as Record<string, unknown> | null;
    expect(kt?.n).toBe(2); // only the 2 binary objective-anchored outcomes folded.
  });

  it('estimates all healthy candidates (multi-candidate happy path)', async () => {
    const good1 = createId();
    const good2 = createId();
    for (const q of [good1, good2]) {
      await seedQuestion(q);
      await seedHardCalibration(q);
      await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
      await seedObjectiveAttempt(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
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
      await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
      await seedObjectiveAttempt(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
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

  // ─── 客观判分门（Bugbot PR-482 fix）──────────────────────────────────────────
  // attempt/review 事件 outcome 字段本身不足以判定客观性——散题 review 事件的 outcome
  // 由 FSRS rating 派生，手评（auto_rate=false）也写 success/failure。KT 估计必须只消费
  // **被独立 judge 事件锚定、且 judge_route ∈ OBJECTIVE_JUDGE_ROUTES** 的 attempt/review 事件，
  // 与硬轨 b 标定（difficulty_calibration_label 的 isObjectiveJudgeRoute 早返）同纪律。

  it('objective gate: excludes binary attempts with NO judge event (FSRS-rating / manual-rate path)', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    // Binary outcome but NO judge event anchors it — mirrors scatter-practice review
    // events whose outcome is FSRS-rating-derived (again→failure, hard/good→success),
    // and manually-rated attempts. Subjective noise must not shape KT parameters.
    await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0); // no objective-judge-anchored event → not a candidate.
    expect(await readKtJson(q)).toBeNull();
  });

  it('objective gate: excludes binary attempts anchored by a NON-objective judge (semantic/LLM)', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    // Judge event exists but judge_route='semantic' (LLM judge) — subjective, not in
    // OBJECTIVE_JUDGE_ROUTES = {'exact','keyword'}. Excluded same as no-judge case.
    const a1 = await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedJudgeEvent(a1, 'semantic', new Date('2026-06-15T10:00:00+08:00'));
    const a2 = await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    await seedJudgeEvent(a2, 'rubric', new Date('2026-06-15T11:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(0);
    expect(await readKtJson(q)).toBeNull();
  });

  it('objective gate: keyword route is also accepted (parity with exact)', async () => {
    // 'keyword' is the other member of OBJECTIVE_JUDGE_ROUTES — must be accepted
    // alongside 'exact' (single-canonical-source: personalized-difficulty.ts).
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    const a1 = await seedAttemptEvent(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedJudgeEvent(a1, 'keyword', new Date('2026-06-15T10:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.considered).toBe(1);
    expect(result.estimated).toBe(1);
    expect(await readKtJson(q)).not.toBeNull();
  });

  it('objective gate: mixed sequence folds ONLY objective-anchored binary outcomes', async () => {
    // Same question, three attempt events:
    //   (a) success, objective-anchored (exact)   → folded
    //   (b) failure, NO judge anchor              → skipped (FSRS-rating / manual)
    //   (c) failure, anchored by semantic (LLM)   → skipped (non-objective)
    //   (d) success, objective-anchored (keyword) → folded
    // KT sequence must be [1, 0] from (a) and (d) only — n=2.
    const q = createId();
    await seedQuestion(q);
    await seedHardCalibration(q);
    await seedObjectiveAttempt(q, 'success', new Date('2026-06-15T10:00:00+08:00'));
    await seedAttemptEvent(q, 'failure', new Date('2026-06-15T10:30:00+08:00')); // no judge
    const c = await seedAttemptEvent(q, 'failure', new Date('2026-06-15T11:00:00+08:00'));
    await seedJudgeEvent(c, 'semantic', new Date('2026-06-15T11:00:00+08:00'));
    const d = await seedAttemptEvent(q, 'success', new Date('2026-06-15T12:00:00+08:00'));
    await seedJudgeEvent(d, 'keyword', new Date('2026-06-15T12:00:00+08:00'));

    const result = await runKtEstimateNightly(db);
    expect(result.estimated).toBe(1);
    const kt = (await readKtJson(q)) as Record<string, unknown> | null;
    expect(kt?.n).toBe(2); // only (a) and (d) folded.
  });
});
