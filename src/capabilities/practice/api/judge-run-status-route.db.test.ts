// YUK-594 (W1) — GET /api/jobs/judge_run/[id]/status (poll tier).
// Covers: unknown run_id → 404 (not a dishonest 200 queued, #7); a queued run → 200
// queued; a done run → 200 done with the structured verdict payload (#11).

import { newId } from '@/core/ids';
import * as bossClient from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { GET } from './judge-run-status-route';

describe('GET /api/jobs/judge_run/[id]/status', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('unknown run_id → 404 (not 200 queued)', async () => {
    // No job_events AND no pg-boss job (getStartedBoss is unavailable in tests → the lookup
    // fails closed to "does not exist", which is exactly the behaviour we want here).
    const res = await GET(new Request('http://localhost'), { id: newId() });
    expect(res.status).toBe(404);
  });

  // W4 #TtWiD — "zero job_events" is NOT "no such run". The queued marker is written AFTER
  // boss.send and is best-effort, so a transient DB blip on that write leaves a genuinely
  // enqueued run with no events. If the worker is also down (no STARTED to heal it), the poll
  // URL advertised in the 202 would 404 — declaring a real run nonexistent in precisely the
  // worker-outage scenario the durable lane exists to cover.
  it('a marker-less run that pg-boss still holds reports queued, not 404', async () => {
    const runId = newId();
    // The run_id IS the pg-boss job id (SendOptions.id at enqueue), so the route resolves it
    // by primary key. Stub the boss client the route uses.
    const getJobById = vi.fn().mockResolvedValue({ id: runId, state: 'created' });
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById,
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('queued');
    expect(body.result).toBeNull();
    expect(getJobById).toHaveBeenCalledWith('judge_run', runId);
    vi.restoreAllMocks();
  });

  it('still 404s when pg-boss has no such job either', async () => {
    const runId = newId();
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById: vi.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });

  // W5 #TumMo — existence is not liveness. `getJobById` returns a row for terminal states
  // too; `expired` in particular is what a marker-less run looks like after a long worker
  // outage. Reporting `queued` for those would make the client poll a job that can never
  // emit another event.
  it.each(['completed', 'failed', 'cancelled', 'expired'])(
    'does NOT report queued for a terminal pg-boss job (state=%s)',
    async (state) => {
      const runId = newId();
      vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
        getJobById: vi.fn().mockResolvedValue({ id: runId, state }),
      } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

      const res = await GET(new Request('http://localhost'), { id: runId });
      expect(res.status).toBe(404);
      vi.restoreAllMocks();
    },
  );

  it.each(['created', 'retry', 'active'])(
    'reports queued for a LIVE pg-boss job (state=%s)',
    async (state) => {
      const runId = newId();
      vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
        getJobById: vi.fn().mockResolvedValue({ id: runId, state }),
      } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

      const res = await GET(new Request('http://localhost'), { id: runId });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('queued');
      vi.restoreAllMocks();
    },
  );

  it('queued run → 200 queued, result null', async () => {
    const runId = newId();
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.QUEUED,
      payload: { caller: 'submit' },
    });
    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('queued');
    expect(body.result).toBeNull();
  });

  it('done run → 200 done with the structured verdict payload', async () => {
    const runId = newId();
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.STARTED,
      payload: { caller: 'submit' },
    });
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.DONE,
      payload: {
        attempt_event_id: runId,
        coarse_outcome: 'correct',
        score: 1,
        feedback_md: 'ok',
        capability_ref: { id: 'semantic', version: '1.0.0' },
      },
    });
    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      result: { coarse_outcome?: string; capability_ref?: { id: string } } | null;
    };
    expect(body.status).toBe('done');
    expect(body.result?.coarse_outcome).toBe('correct');
    expect(body.result?.capability_ref?.id).toBe('semantic');
  });

  // #7 — a DONE whose payload fails the result contract still degrades to `result: null`
  // (a 500 on a poll would be worse), but the degradation must be OBSERVABLE: pre-fix it
  // was completely silent, so a malformed/legacy terminal payload in production could not
  // be diagnosed from the response at all.
  it('logs a warning when a DONE payload fails the result contract (degrade is observable)', async () => {
    const runId = newId();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `attempt_event_id` is required by JudgeRunTerminalResultSchema — this DONE is malformed.
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.DONE,
      payload: { coarse_outcome: 'correct' },
    });

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('done');
    expect(body.result).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('failed the result contract');
    warn.mockRestore();
  });
});
