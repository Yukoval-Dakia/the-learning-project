// Terminal notification failures must preserve committed truth and remain recoverable.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event } from '@/db/schema';
import { computeReplay } from '@/server/events/sse_replay';
import { nativeJudgeRunFixture } from '../../../../tests/fixtures/native-judge-run';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { deriveJudgeRunStatus } from '../server/judge-run-status';
import { type JudgeRunJobData, runJudgeRun } from './judge_run';

const { writeJobEventSpy, failOn } = vi.hoisted(() => ({
  writeJobEventSpy: vi.fn(),
  failOn: { eventType: 'judge_run.done', remaining: Number.POSITIVE_INFINITY },
}));

vi.mock('@/server/events/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/events/writer')>();
  writeJobEventSpy.mockImplementation(async (db: unknown, args: { event_type: string }) => {
    if (args.event_type === failOn.eventType && failOn.remaining > 0) {
      failOn.remaining -= 1;
      throw new Error(`${failOn.eventType} write boom`);
    }
    return actual.writeJobEvent(
      db as Parameters<typeof actual.writeJobEvent>[0],
      args as Parameters<typeof actual.writeJobEvent>[1],
    );
  });
  return { ...actual, writeJobEvent: writeJobEventSpy };
});

beforeEach(async () => {
  await resetDb();
  writeJobEventSpy.mockClear();
  failOn.eventType = 'judge_run.done';
  failOn.remaining = Number.POSITIVE_INFINITY;
});
afterEach(() => vi.restoreAllMocks());
const first = { retryCount: 0, retryLimit: 2 };
const final = { retryCount: 2, retryLimit: 2 };
const types = () => writeJobEventSpy.mock.calls.map((call) => call[1].event_type);
async function replay(runId: string) {
  return computeReplay(testDb(), { businessTable: 'judge_run', businessId: runId, lastEventId: 0 });
}

describe('native judge terminal notification recovery', () => {
  it('rethrows a failed DONE notification after commit without writing FAILED', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await expect(runJudgeRun(db, f.job, first)).rejects.toThrow('judge_run.done write boom');
    expect(await db.select().from(event).where(eq(event.id, f.runId))).toHaveLength(1);
    expect(types()).toContain('judge_run.done');
    expect(types()).not.toContain('judge_run.failed');
    failOn.remaining = 0;
    expect((await runJudgeRun(db, f.job, { ...first, retryCount: 1 })).status).toBe('skipped');
    expect(deriveJudgeRunStatus(await replay(f.runId))).toBe('done');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('rethrows when a permanent failure cannot write its FAILED terminal', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    failOn.eventType = 'judge_run.failed';
    const bad = { ...f.job, caller: 'unknown' } as unknown as JudgeRunJobData;
    await expect(runJudgeRun(db, bad, first)).rejects.toThrow('judge_run.failed write boom');
    expect(types()).toContain('judge_run.failed');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('does not report success when an exhausted execution failure also loses FAILED', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    failOn.eventType = 'judge_run.failed';
    await expect(
      runJudgeRun(db, f.job, final, {
        executeNativeAttemptFn: async () => {
          throw new Error('database unavailable');
        },
      }),
    ).rejects.toThrow('judge_run.failed write boom');
    expect(await db.select().from(event).where(eq(event.id, f.runId))).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('retries transient DONE writes on the final delivery without another model execution', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    failOn.remaining = 2;
    expect((await runJudgeRun(db, f.job, final)).status).toBe('done');
    expect(await db.select().from(event).where(eq(event.id, f.runId))).toHaveLength(1);
    const events = await replay(f.runId);
    expect(deriveJudgeRunStatus(events)).toBe('done');
    expect(events.filter((row) => row.event_type === 'judge_run.done')).toHaveLength(1);
    expect(types().filter((type) => type === 'judge_run.done')).toHaveLength(3);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('retries transient FAILED writes on the final delivery and still propagates the execution failure', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    failOn.eventType = 'judge_run.failed';
    failOn.remaining = 2;
    await expect(
      runJudgeRun(db, f.job, final, {
        executeNativeAttemptFn: async () => {
          throw new Error('database unavailable');
        },
      }),
    ).rejects.toThrow('database unavailable');
    const events = await replay(f.runId);
    expect(deriveJudgeRunStatus(events)).toBe('failed');
    expect(events.filter((row) => row.event_type === 'judge_run.failed')).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
