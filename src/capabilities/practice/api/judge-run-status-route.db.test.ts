// YUK-594 (W1) — GET /api/jobs/judge_run/[id]/status (poll tier).
// Covers: unknown run_id → 404 (not a dishonest 200 queued, #7); a queued run → 200
// queued; a done run → 200 done with the structured verdict payload (#11).

import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import * as bossClient from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { judgeRunJobId } from '../server/judge-run-dispatch';
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
    // YUK-777 — the job id is DERIVED from the run handle, not equal to it: pg-boss job ids
    // are uuid columns and run handles are cuid2s, so the original `{ id: runId }` would have
    // thrown against real pg-boss. This assertion used to pass only because the fake accepted
    // any string. The route re-derives the same uuid, so the lookup is still a PK hit.
    const jobId = judgeRunJobId(runId);
    const getJobById = vi.fn().mockResolvedValue({ id: jobId, state: 'created' });
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById,
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe('queued');
    expect(body.result).toBeNull();
    expect(getJobById).toHaveBeenCalledWith('judge_run', jobId);
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

  // W5 #TumMo — existence is not liveness. `getJobById` returns a row for terminal states too,
  // and reporting `queued` for one would make the client poll a job that can never emit another
  // event. (pg-boss 12's state union has no `expired`: a job the worker never picked up before
  // its expire window lands in `failed`, which is covered here.)
  it.each(['completed', 'failed', 'cancelled'])(
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

  // W5 #Tunn3 / #Tunn2 — `job_events` is the progress stream, NOT the source of truth: it is
  // pruned on a retention window and its terminal write can fail outright. The permanent
  // record is the review + judge event pair the backfill tx commits, so a run whose verdict
  // is durably persisted must resolve to `done` even with ZERO job_events.
  it('reconstructs done from the DOMAIN events when job_events are gone', async () => {
    const db = testDb();
    const runId = newId();
    const questionId = `q_${newId()}`;
    // The attempt (review) event — id = run_id, shaped exactly as persistSubmit writes it:
    // the verdict is EMBEDDED under `payload.judge`, which is the only place `evidence_json`
    // is ever persisted (#TuxJL).
    await db.insert(event).values({
      id: runId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        judge: {
          route: 'semantic',
          score: 1,
          coarse_outcome: 'correct',
          confidence: 0.9,
          feedback_md: 'ok',
          evidence_json: { spans: ['x'] },
          capability_ref: { id: 'semantic', version: '1.0.0' },
        },
      },
    });
    // The judge event chained to it — note it carries NO evidence_json and NO score_meaning.
    const judgeEventId = newId();
    await db.insert(event).values({
      id: judgeEventId,
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: runId,
      outcome: 'success',
      payload: {
        coarse_outcome: 'correct',
        score: 1,
        feedback_md: 'ok',
        judge_route: 'semantic',
      },
    });

    // No job_events at all, and pg-boss has nothing either (retention pruned both).
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById: vi.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      result: {
        coarse_outcome?: string;
        evidence_json?: unknown;
        score_meaning?: string;
        judge_event_id?: string;
      } | null;
    };
    // Pre-fix this 404'd — telling a returning client its persisted verdict did not exist.
    expect(body.status).toBe('done');
    expect(body.result?.coarse_outcome).toBe('correct');
    expect(body.result?.judge_event_id).toBe(judgeEventId);
    // #TuxJL — evidence comes from the review event's embedded `payload.judge`, which is the
    // only place it is persisted. Reading it off the judge event (as an earlier revision did)
    // silently returned nothing, and the all-optional schema let that loss pass validation.
    expect(body.result?.evidence_json).toEqual({ spans: ['x'] });
    // …and `score_meaning` is HONESTLY absent: JudgeResultV2 carries it, but persistSubmit
    // writes it to neither event, so there is nothing to reconstruct. Persisting it is a W3
    // item (YUK-777) — inventing a default here would be worse than the gap.
    expect(body.result?.score_meaning).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('still 404s when neither job_events NOR a domain attempt event exist', async () => {
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById: vi.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);
    const res = await GET(new Request('http://localhost'), { id: newId() });
    expect(res.status).toBe(404);
    vi.restoreAllMocks();
  });

  // W5 #TusVC — liveness applies to EVERY non-terminal run, not just marker-less ones. A run
  // whose worker was hard-killed after writing STARTED, whose job then exhausted into the DLQ,
  // has a live-looking event trail and a dead job — `started` forever told the client to poll
  // a corpse.
  it('a STARTED run whose queue job is dead and which never persisted reports failed', async () => {
    const runId = newId();
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.STARTED,
      payload: { caller: 'submit' },
    });
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById: vi.fn().mockResolvedValue({ id: runId, state: 'failed' }),
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('failed');
    vi.restoreAllMocks();
  });

  it('a STARTED run whose queue job is dead BUT which did persist reports the real verdict', async () => {
    const db = testDb();
    const runId = newId();
    await writeJobEvent(db, {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.STARTED,
      payload: { caller: 'submit' },
    });
    // The backfill committed; only the terminal job_event never landed (#Tunn2).
    await db.insert(event).values({
      id: runId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: `q_${newId()}`,
      outcome: 'success',
      payload: { fsrs_rating: 'good' },
    });
    await db.insert(event).values({
      id: newId(),
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: runId,
      outcome: 'success',
      payload: { coarse_outcome: 'correct', score: 1, judge_route: 'semantic' },
    });
    vi.spyOn(bossClient, 'getStartedBoss').mockResolvedValue({
      getJobById: vi.fn().mockResolvedValue({ id: runId, state: 'failed' }),
    } as unknown as Awaited<ReturnType<typeof bossClient.getStartedBoss>>);

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      result: { coarse_outcome?: string } | null;
    };
    expect(body.status).toBe('done');
    expect(body.result?.coarse_outcome).toBe('correct');
    vi.restoreAllMocks();
  });

  it('an UNREACHABLE pg-boss never upgrades a lookup blip into a verdict', async () => {
    const runId = newId();
    await writeJobEvent(testDb(), {
      business_table: JUDGE_RUN_TABLE,
      business_id: runId,
      event_type: JUDGE_RUN_EVENTS.STARTED,
      payload: { caller: 'submit' },
    });
    vi.spyOn(bossClient, 'getStartedBoss').mockRejectedValue(new Error('pg-boss down'));

    const res = await GET(new Request('http://localhost'), { id: runId });
    expect(res.status).toBe(200);
    // Reports what the events say — NOT `failed`, which would be a far worse lie than a
    // stale `started` when the truth is simply unknown.
    expect(((await res.json()) as { status: string }).status).toBe('started');
    vi.restoreAllMocks();
  });

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
