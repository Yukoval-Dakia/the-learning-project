// YUK-576 §5 — stuck-in-running reconcile sweeper (DB semantics).
//
// The runner's finish-write can fail (DB outage) or the process can die before
// the finally block — the ai_task_runs row then sticks at status='running'
// forever. The sweeper converges OBSERVATION STATE ONLY: no domain writes, no
// job re-emission, no LLM re-run (design doc §5.2). Threshold 1h vs the largest
// budget.timeout (300s) = 12× margin — a >1h 'running' row cannot be a live run
// (cooperative abort bounds real run lifetime), so false convergence of a live
// run is structurally excluded.

import { ai_task_runs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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
  });
});
