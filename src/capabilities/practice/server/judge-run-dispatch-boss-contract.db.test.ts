// YUK-777 (A3) — the two REAL pg-boss behaviours the recovery design is built on.
//
// Why this runs against real pg-boss rather than the `{ send, getJobById }` fake the sweeper
// tests inject: both assertions below are claims about pg-boss ITSELF, and a fake would just
// replay whatever I assumed while writing it. That is the failure shape #1076 hit — a test
// double more complete than production, keeping a broken path green.
//
// The two claims, and what each one decides:
//
//   ① `send(queue, data, { id })` with an id that ALREADY EXISTS returns null, even when the
//      existing job is terminal. This is why `judge_pending_reconcile` re-enqueues with NO
//      job id: the run handle is permanently occupied by the dead job, so pinning it would
//      make every recovery attempt a silent no-op for the rest of the run's life.
//   ② `getJobById` answers for a terminal job, so liveness must read `state` and not mere
//      existence — otherwise the sweeper would treat every finished-or-dead run as alive and
//      recover nothing at all.

import { newId } from '@/core/ids';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeRunJobId } from './judge-run-dispatch';

/** Isolated schema so this never touches the app's `pgboss` singleton or a parallel fork. */
const TEST_SCHEMA = 'pgboss_yuk777';

let boss: PgBoss;
let queueSeq = 0;

/** A queue per case: `fetch()` pops the queue head, so a shared queue leaks jobs between them. */
async function freshQueue(options: { retryLimit?: number } = {}): Promise<string> {
  const name = `yuk777_probe_${queueSeq++}`;
  await boss.createQueue(name, options as never);
  return name;
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  boss = new PgBoss({ connectionString, schema: TEST_SCHEMA, max: 2 });
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

describe('pg-boss dispatch contract (YUK-777)', () => {
  it('⓪ a run handle is NOT a usable pg-boss job id — the derived uuid is', async () => {
    // The bug W2 shipped (flag-off, so never exercised): `newId()` is a cuid2 and pg-boss job
    // ids are `uuid` columns. Every fake boss in the suite accepted it, so only real pg-boss
    // could show that the first flag-on submit would have thrown.
    const QUEUE = await freshQueue();
    const runId = newId();
    await expect(boss.send(QUEUE, { run_id: runId }, { id: runId })).rejects.toThrow(/uuid/i);
    // …and the derived id is accepted, on both the send and the lookup the poll route uses.
    const jobId = judgeRunJobId(runId);
    expect(await boss.send(QUEUE, { run_id: runId }, { id: jobId })).toBe(jobId);
    expect((await boss.getJobById(QUEUE, jobId))?.state).toBe('created');
    // Deterministic: the poll route and the sweeper re-derive it rather than storing a mapping.
    expect(judgeRunJobId(runId)).toBe(jobId);
  });

  it('① an explicit job id is single-use — a terminal job still blocks its own id forever', async () => {
    // retryLimit 0 so `fail` lands TERMINAL immediately. (With retries left it lands in
    // `retry`, which `LIVE_BOSS_STATES` correctly counts as still-live — the case this test
    // is not about.)
    const QUEUE = await freshQueue({ retryLimit: 0 });
    const runId = judgeRunJobId(newId());

    const first = await boss.send(QUEUE, { run_id: runId }, { id: runId });
    expect(first).toBe(runId);

    // Drive it to a terminal state, the way a DLQ-exhausted judge_run ends up.
    const [job] = (await boss.fetch(QUEUE)) ?? [];
    expect(job?.id).toBe(runId);
    await boss.fail(QUEUE, runId);
    const failed = await boss.getJobById(QUEUE, runId);
    expect(failed?.state).toBe('failed');

    // THE CLAIM: re-sending with the same id is refused (ON CONFLICT DO NOTHING → null).
    // Production reads a null jobId as "nothing was enqueued", so a sweeper that pinned the
    // run handle would report success-shaped failure on every single recovery.
    const requeueWithSameId = await boss.send(QUEUE, { run_id: runId }, { id: runId });
    expect(requeueWithSameId).toBeNull();

    // …and the recovery path's actual shape — no id — does enqueue a real, distinct job that
    // still carries the same `run_id` in its payload (which is what keeps the handler's
    // run_id-keyed idempotency guard effective).
    const recovered = await boss.send(QUEUE, { run_id: runId });
    expect(recovered).not.toBeNull();
    expect(recovered).not.toBe(runId);
    const recoveredJob = await boss.getJobById(QUEUE, recovered as string);
    expect((recoveredJob?.data as { run_id: string }).run_id).toBe(runId);
  });

  it('② getJobById answers for terminal jobs, so liveness must read state, not existence', async () => {
    const QUEUE = await freshQueue();
    const id = judgeRunJobId(newId());
    await boss.send(QUEUE, { run_id: id }, { id });

    const queued = await boss.getJobById(QUEUE, id);
    expect(queued?.state).toBe('created');

    const [job] = (await boss.fetch(QUEUE)) ?? [];
    expect(job?.id).toBe(id);
    expect((await boss.getJobById(QUEUE, id))?.state).toBe('active');

    await boss.complete(QUEUE, id);
    const done = await boss.getJobById(QUEUE, id);
    // Non-null AND terminal: an existence check would call this "live" and the sweeper would
    // never act on a run that finished (or died) without persisting a verdict.
    expect(done).not.toBeNull();
    expect(done?.state).toBe('completed');
  });
});
