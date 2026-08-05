import { ai_task_runs, cost_ledger } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  writeAiTaskAttemptFinished,
  writeAiTaskRunRetried,
  writeCostLedger,
  writeToolCallLog,
} from './log';

describe('writeToolCallLog', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a row with all required fields', async () => {
    const db = testDb();
    await writeToolCallLog(db, {
      task_run_id: 'tr_1',
      task_kind: 'AttributionTask',
      tool_name: 'search_knowledge_by_concept',
      input_json: { concept: '宾语前置' },
      output_json: { results: [] },
      iteration: 1,
      latency_ms: 234,
      cost: 0.001,
    });

    const { tool_call_log } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(tool_call_log).where(eq(tool_call_log.task_run_id, 'tr_1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].task_kind).toBe('AttributionTask');
    expect(rows[0].tool_name).toBe('search_knowledge_by_concept');
    expect(rows[0].iteration).toBe(1);
  });
});

describe('writeCostLedger', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a row with all required fields', async () => {
    const db = testDb();
    await writeCostLedger(db, {
      task_kind: 'AttributionTask',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      cost: 0.012,
      tokens_in: 1234,
      tokens_out: 567,
    });

    const rows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('anthropic');
    expect(rows[0].model).toBe('claude-sonnet-4-6');
    expect(rows[0].tokens_in).toBe(1234);
    expect(rows[0].tokens_out).toBe(567);
    expect(rows[0]).toMatchObject({
      entry_kind: 'legacy',
      cost_basis: null,
      cost_ref: null,
    });
  });
});

describe('writeAiTaskAttemptFinished', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedRunning(id: string) {
    const db = testDb();
    await db.insert(ai_task_runs).values({
      id,
      task_kind: 'AttributionTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      input_hash: `hash_${id}`,
      status: 'running',
      started_at: new Date(),
    });
    return db;
  }

  it('projects one truth into the run and one attempt ledger atomically', async () => {
    const db = await seedRunning('attempt_ok');
    const settled = await writeAiTaskAttemptFinished(db, {
      id: 'attempt_ok',
      status: 'success',
      finish_reason: 'stop',
      usage: { inputTokens: 10, outputTokens: 2 },
      cost_truth: { basis: 'estimated', amountUsd: 0.004, ref: 'pricebook:test' },
      outcome: 'success',
    });

    expect(settled).toBe(true);
    const [run] = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, 'attempt_ok'));
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, 'attempt_ok'));
    expect(run).toMatchObject({
      status: 'success',
      cost_usd: 0.004,
      cost_basis: 'estimated',
      cost_ref: 'pricebook:test',
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entry_kind: 'attempt',
      cost: 0.004,
      cost_basis: 'estimated',
      cost_ref: 'pricebook:test',
      tokens_in: 10,
      tokens_out: 2,
    });
  });

  it('rolls the run update back when the attempt ledger insert faults', async () => {
    const db = await seedRunning('attempt_conflict');
    await db.insert(cost_ledger).values({
      id: 'preexisting_attempt',
      task_run_id: 'attempt_conflict',
      task_kind: 'AttributionTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      cost: null,
      currency: 'USD',
      entry_kind: 'attempt',
      cost_basis: 'unknown',
      cost_ref: 'unpriced:xiaomi/mimo-v2.5-pro',
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'failed_retryable',
      occurred_at: new Date(),
    });

    await expect(
      writeAiTaskAttemptFinished(db, {
        id: 'attempt_conflict',
        status: 'failure',
        finish_reason: 'error',
        usage: { inputTokens: 1, outputTokens: 1 },
        cost_truth: { basis: 'reported', amountUsd: 0.1, ref: 'sdk:total_cost_usd' },
        outcome: 'failed_permanent',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    const [run] = await db
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, 'attempt_conflict'));
    expect(run).toMatchObject({ status: 'running', cost_usd: null, cost_basis: null });
  });

  it('marks retry only for a settled failure that is still conservatively error', async () => {
    const db = await seedRunning('attempt_retry_marker');
    await writeAiTaskAttemptFinished(db, {
      id: 'attempt_retry_marker',
      status: 'failure',
      finish_reason: 'error',
      usage: { inputTokens: 1, outputTokens: 0 },
      cost_truth: { basis: 'unknown', amountUsd: null, ref: 'unpriced:test/model' },
      outcome: 'failed_retryable',
    });

    expect(await writeAiTaskRunRetried(db, 'attempt_retry_marker')).toBe(true);
    expect(await writeAiTaskRunRetried(db, 'attempt_retry_marker')).toBe(false);
    const [run] = await db
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, 'attempt_retry_marker'));
    expect(run.finish_reason).toBe('error_retried');
  });

  it('returns false and writes no ledger for a missing or already-terminal run', async () => {
    const db = await seedRunning('attempt_done');
    await db
      .update(ai_task_runs)
      .set({ status: 'failure', finished_at: new Date() })
      .where(eq(ai_task_runs.id, 'attempt_done'));

    const input = {
      status: 'failure' as const,
      finish_reason: 'error',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost_truth: { basis: 'unknown' as const, amountUsd: null, ref: 'unpriced:test/model' },
      outcome: 'failed_permanent' as const,
    };
    expect(await writeAiTaskAttemptFinished(db, { id: 'missing', ...input })).toBe(false);
    expect(await writeAiTaskAttemptFinished(db, { id: 'attempt_done', ...input })).toBe(false);
    expect(await db.select().from(cost_ledger)).toHaveLength(0);
  });
});
