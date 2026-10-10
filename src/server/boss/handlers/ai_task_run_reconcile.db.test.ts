// YUK-576 §5 — stuck-in-running reconcile sweeper (DB semantics).
//
// The runner's finish-write can fail (DB outage) or the process can die before
// the finally block — the ai_task_runs row then sticks at status='running'
// forever. The sweeper converges OBSERVATION STATE ONLY: no domain writes, no
// job re-emission, no LLM re-run (design doc §5.2). Threshold 1h vs the largest
// effective per-call timeout (45min durable copilot after the uncapped-budget
// change) ≈ 1.3× margin — a >1h 'running' row cannot be a live run (cooperative
// abort bounds real run lifetime), so false convergence of a live run is
// structurally excluded.

import { beforeEach, describe, expect, it } from 'vitest';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { STUCK_RUN_THRESHOLD_MS, reconcileStuckAiTaskRuns } from './ai_task_run_reconcile';

const db = testDb();

const NOW = new Date('2026-07-07T12:00:00Z');
const STUCK_STARTED_AT = new Date(NOW.getTime() - STUCK_RUN_THRESHOLD_MS - 60_000); // 1h+1min ago

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

describe('reconcileStuckAiTaskRuns (YUK-576 §5)', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
  });

  it('is idempotent: a second sweep converges zero rows', async () => {
    await seedRun({ status: 'running', started_at: STUCK_STARTED_AT });

    const first = await reconcileStuckAiTaskRuns(db, NOW);
    const second = await reconcileStuckAiTaskRuns(db, NOW);

    expect(first.reconciled).toBe(1);
    expect(second.reconciled).toBe(0);
    expect(await db.select().from(cost_ledger)).toHaveLength(1);
  });
});
