// YUK-576 §5 — stuck-in-running reconcile sweeper (DB semantics).
//
// The runner's finish-write can fail (DB outage) or the process can die before
// the finally block — the ai_task_runs row then sticks at status='running'
// forever. The sweeper converges OBSERVATION STATE ONLY: no domain writes, no
// job re-emission, no LLM re-run (design doc §5.2). Threshold 1h vs the largest
// effective per-call timeout (12min) = 5× margin — a >1h 'running' row cannot
// be a live run (cooperative abort bounds real run lifetime), so false
// convergence of a live run is structurally excluded.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  RECONCILED_STUCK_FINISH_REASON,
  STUCK_RUN_THRESHOLD_MS,
  reconcileStuckAiTaskRuns,
} from './ai_task_run_reconcile';

const db = testDb();

const NOW = new Date('2026-07-07T12:00:00Z');
const STUCK_STARTED_AT = new Date(NOW.getTime() - STUCK_RUN_THRESHOLD_MS - 60_000); // 1h+1min ago
const FRESH_STARTED_AT = new Date(NOW.getTime() - 5 * 60_000); // 5min ago (< threshold)

let seq = 0;

async function seedRun(opts: {
  status: string;
  started_at: Date;
  finished_at?: Date | null;
  finish_reason?: string | null;
}): Promise<string> {
  seq += 1;
  const id = `run_${seq}`;
  await db.insert(ai_task_runs).values({
    id,
    task_kind: 'StepsJudgeTask',
    provider: 'test',
    model: 'test-model',
    input_hash: `h_${seq}`,
    status: opts.status,
    started_at: opts.started_at,
    finished_at: opts.finished_at ?? null,
    finish_reason: opts.finish_reason ?? null,
  });
  return id;
}

async function loadRun(id: string) {
  const [row] = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, id));
  return row;
}

describe('reconcileStuckAiTaskRuns (YUK-576 §5)', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
  });

  it("converges a >1h 'running' row to status='failure' + finish_reason='reconciled_stuck' + finished_at", async () => {
    const id = await seedRun({ status: 'running', started_at: STUCK_STARTED_AT });

    const result = await reconcileStuckAiTaskRuns(db, NOW);

    expect(result.reconciled).toBe(1);
    const row = await loadRun(id);
    // status stays inside the closed vocabulary {running, success, failure} —
    // 'error' would be invisible to the admin failure surface (ai-observability
    // filters eq(status,'failure')); the sub-classification rides finish_reason.
    expect(row.status).toBe('failure');
    expect(row.finish_reason).toBe(RECONCILED_STUCK_FINISH_REASON);
    expect(row.finished_at).not.toBeNull();
    expect(row.error_message).toContain('sweeper');
    expect(row).toMatchObject({
      cost_usd: null,
      cost_basis: 'unknown',
      cost_ref: 'unpriced:test/test-model',
    });
    const ledger = await db.select().from(cost_ledger).where(eq(cost_ledger.task_run_id, id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entry_kind: 'attempt',
      cost: null,
      cost_basis: 'unknown',
      cost_ref: 'unpriced:test/test-model',
      outcome: 'failed_permanent',
    });
  });

  it('leaves a fresh running row (< threshold) untouched — no live-run false convergence', async () => {
    const id = await seedRun({ status: 'running', started_at: FRESH_STARTED_AT });

    const result = await reconcileStuckAiTaskRuns(db, NOW);

    expect(result.reconciled).toBe(0);
    const row = await loadRun(id);
    expect(row.status).toBe('running');
    expect(row.finish_reason).toBeNull();
  });

  it('never touches terminal rows (success / failure), even old ones', async () => {
    const okId = await seedRun({
      status: 'success',
      started_at: STUCK_STARTED_AT,
      finished_at: STUCK_STARTED_AT,
      finish_reason: 'stop',
    });
    const failId = await seedRun({
      status: 'failure',
      started_at: STUCK_STARTED_AT,
      finished_at: STUCK_STARTED_AT,
      finish_reason: 'error',
    });

    const result = await reconcileStuckAiTaskRuns(db, NOW);

    expect(result.reconciled).toBe(0);
    expect((await loadRun(okId)).finish_reason).toBe('stop');
    expect((await loadRun(failId)).finish_reason).toBe('error');
  });

  it('is idempotent: a second sweep converges zero rows', async () => {
    await seedRun({ status: 'running', started_at: STUCK_STARTED_AT });

    const first = await reconcileStuckAiTaskRuns(db, NOW);
    const second = await reconcileStuckAiTaskRuns(db, NOW);

    expect(first.reconciled).toBe(1);
    expect(second.reconciled).toBe(0);
    expect(await db.select().from(cost_ledger)).toHaveLength(1);
  });

  // YUK-843 — one poisoned row must not abort the whole sweep. The settle
  // transaction (terminal update + ledger insert) throws on DB/constraint
  // errors; pre-fix, that error escaped the loop and killed every later row's
  // convergence until the next cron tick re-ran the whole batch.
  it('isolates a per-row settle failure: remaining rows still converge, failed row stays running (YUK-843)', async () => {
    // Deterministic processing order: same started_at, id tiebreak run_1 < run_2 < run_3.
    const firstId = await seedRun({ status: 'running', started_at: STUCK_STARTED_AT });
    const middleId = await seedRun({ status: 'running', started_at: STUCK_STARTED_AT });
    const lastId = await seedRun({ status: 'running', started_at: STUCK_STARTED_AT });

    // Poison ONLY the middle run's settle, via the real production seam: a
    // pre-existing attempt ledger row trips the cost_ledger_attempt_task_run_uq
    // partial unique index, so writeAiTaskAttemptFinished's ledger insert
    // throws and the transaction rolls the terminal update back with it.
    await db.insert(cost_ledger).values({
      id: 'ledger_poison_middle',
      task_run_id: middleId,
      task_kind: 'StepsJudgeTask',
      provider: 'test',
      model: 'test-model',
      cost: null,
      currency: 'USD',
      entry_kind: 'attempt',
      cost_basis: 'unknown',
      cost_ref: 'unpriced:test/test-model',
      tokens_in: 0,
      tokens_out: 0,
      outcome: 'failed_permanent',
      occurred_at: STUCK_STARTED_AT,
    });

    const result = await reconcileStuckAiTaskRuns(db, NOW);

    // Only the two healthy rows count as reconciled.
    expect(result.reconciled).toBe(2);
    expect((await loadRun(firstId)).status).toBe('failure');
    expect((await loadRun(lastId)).status).toBe('failure');
    // The poisoned settle rolled back entirely: the row stays running (and
    // matchable by the next sweep) instead of being half-converged.
    const middle = await loadRun(middleId);
    expect(middle.status).toBe('running');
    expect(middle.finished_at).toBeNull();
    expect(middle.finish_reason).toBeNull();
    // First + last each got exactly their one sweeper attempt row; the middle
    // kept only the poison row (its insert rolled back).
    for (const id of [firstId, lastId]) {
      const rows = await db.select().from(cost_ledger).where(eq(cost_ledger.task_run_id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_kind).toBe('attempt');
    }
    expect(
      await db.select().from(cost_ledger).where(eq(cost_ledger.task_run_id, middleId)),
    ).toHaveLength(1);
  });
});
