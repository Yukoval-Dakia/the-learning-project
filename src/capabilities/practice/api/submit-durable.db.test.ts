// Real native publication/issuance/dispatch; external queue only is offline.
// Retains W2 session gating, YUK-777 outbox recovery and paid admission invariants.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import {
  assessment_submission,
  event,
  job_events,
  learning_session,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { computeReplay } from '@/server/events/sse_replay';
import { __resetRateLimitForTests, checkRateLimit } from '@/server/http/rate-limit';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { dispatchNativeAttempt } from '../server/assessment/durable-attempt';
import { JUDGE_PENDING_ATTEMPT_ACTION, judgeRunJobId } from '../server/judge-run-dispatch';
import { deriveJudgeRunStatus } from '../server/judge-run-status';
import { createAttempt, sessionAdmitsDurableDivert } from './submit';

async function fixture(model = true) {
  const db = testDb();
  const id = `q_${newId()}`;
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `原题 ${id}：顺流18、逆流12，解释如何消去水速。`,
    kind: 'short_answer',
    reference_md: '两式相加，静水速度15 km/h',
    judge_kind_override: 'exact',
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    version: 0,
    created_at: now,
    updated_at: now,
  });
  const issued = await issueSoloFixture(db, id, model);
  const request = issued.assessment('v+c=18，v-c=12。相加得2v=30，因此v=15 km/h。');
  const options = { enabled: true, capture: { response_md: '原始观察文本', latency_ms: 321 } };
  const send = vi.fn().mockResolvedValue('job-1');
  return { db, id, issued, request, options, send };
}
async function pending(db: ReturnType<typeof testDb>) {
  return db.select().from(event).where(eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION));
}
async function seedSession(type: string) {
  const id = newId();
  const now = new Date();
  await testDb().insert(learning_session).values({
    id,
    type,
    status: 'started',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}
beforeEach(async () => {
  await resetDb();
  __resetRateLimitForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('native submit durable dispatch', () => {
  it('flag-OFF explicit self-report remains synchronous and schedules immediately', async () => {
    const f = await fixture();
    const response = await createAttempt(
      new Request('http://local/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question_id: f.id,
          rating: 'good',
          self_report: true,
          assessment: f.request,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'effective',
      review_event: { id: expect.any(String) },
      judge: null,
    });
    expect(await pending(f.db)).toHaveLength(0);
    expect(await f.db.select().from(material_fsrs_state)).toMatchObject([{ state: { reps: 1 } }]);
  });

  it('dispatches only a declared model task and respects disabled dispatch', async () => {
    const model = await fixture();
    expect(
      await dispatchNativeAttempt(
        model.db,
        model.id,
        model.request,
        { ...model.options, enabled: false },
        { boss: { send: model.send } },
      ),
    ).toBeNull();
    expect(model.send).not.toHaveBeenCalled();
    expect(
      await dispatchNativeAttempt(model.db, model.id, model.request, model.options, {
        boss: { send: model.send },
      }),
    ).toBeTruthy();
    const local = await fixture(false);
    expect(
      await dispatchNativeAttempt(local.db, local.id, local.request, local.options, {
        boss: { send: local.send },
      }),
    ).toBeNull();
    expect(local.send).not.toHaveBeenCalled();
  });

  it('writes queued status with immutable original coordinates and learning scope', async () => {
    const f = await fixture();
    const runId = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, {
      boss: { send: f.send },
    });
    expect(runId).toBeTruthy();
    if (!runId) throw new Error('expected durable run ID');
    expect(
      deriveJudgeRunStatus(
        await computeReplay(f.db, {
          businessTable: 'judge_run',
          businessId: runId,
          lastEventId: 0,
        }),
      ),
    ).toBe('queued');
    expect(f.send).toHaveBeenCalledTimes(1);
    const [original] = await f.db.select().from(assessment_submission);
    expect(f.send.mock.calls[0].slice(0, 2)).toMatchObject([
      'judge_run',
      {
        run_id: runId,
        caller: 'native_assessment',
        submit: {
          submission_id: original.submission_id,
          evaluation_group_id: f.request.evaluation_group_id,
          question_id: f.id,
          submitted_at: original.submitted_at.toISOString(),
          capture: f.options.capture,
        },
      },
    ]);
    expect(original.response_set).toEqual(f.request.response_set);
    const [receipt] = await f.db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:assessment_submission'));
    expect(receipt.payload.learning_scope).toMatchObject({
      questions: [{ id: f.id, knowledge_ids: ['k1'], difficulty: 3 }],
    });
    expect(f.issued.practice_dto.faces[0].prompt_md).toContain('顺流18');
    expect(await f.db.select().from(event).where(eq(event.id, runId))).toHaveLength(0);
  });

  it('a boss.send failure preserves the accepted answer without a misleading queued marker', async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error('boss down'));
    const before = await f.db.select().from(job_events);
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, {
      boss: { send: f.send },
    });
    expect(run).toBeTruthy();
    expect(await f.db.select().from(job_events)).toEqual(before);
    expect(await pending(f.db)).toMatchObject([{ payload: { run_id: run } }]);
    expect(await f.db.select().from(assessment_submission)).toMatchObject([
      { response_set: f.request.response_set },
    ]);
  });

  it('a null boss.send also preserves the original for domain recovery', async () => {
    const f = await fixture();
    f.send.mockResolvedValue(null);
    const before = await f.db.select().from(job_events);
    expect(
      await dispatchNativeAttempt(f.db, f.id, f.request, f.options, { boss: { send: f.send } }),
    ).toBeTruthy();
    expect(await f.db.select().from(job_events)).toEqual(before);
    expect(await pending(f.db)).toHaveLength(1);
    expect(await f.db.select().from(assessment_submission)).toMatchObject([
      { response_set: f.request.response_set },
    ]);
  });

  it('rejects a new dispatch when the shared paid admission window is full', async () => {
    const f = await fixture();
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    checkRateLimit();
    await expect(
      dispatchNativeAttempt(f.db, f.id, f.request, f.options, { boss: { send: f.send } }),
    ).rejects.toMatchObject({ status: 429 });
    expect(f.send).not.toHaveBeenCalled();
    expect(await pending(f.db)).toHaveLength(0);
  });

  it('honours the injected admission gate before enqueue or outbox creation', async () => {
    const f = await fixture();
    const gate = vi.fn(() => {
      throw new ApiError('rate_limited', 'over budget', 429);
    });
    await expect(
      dispatchNativeAttempt(f.db, f.id, f.request, f.options, {
        boss: { send: f.send },
        checkRateLimit: gate,
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(await pending(f.db)).toHaveLength(0);
  });

  it('PLACEMENT sessions stay synchronous so next-item reads have a persisted verdict', async () => {
    expect(await sessionAdmitsDurableDivert(await seedSession('placement'))).toBe(false);
  });
  it('REVIEW sessions admit the pending protocol', async () => {
    expect(await sessionAdmitsDurableDivert(await seedSession('review'))).toBe(true);
  });
  it('ad-hoc solo practice admits the pending protocol', async () => {
    expect(await sessionAdmitsDurableDivert(null)).toBe(true);
  });
  it('unadmitted and unknown sessions fail closed to synchronous execution', async () => {
    expect(await sessionAdmitsDurableDivert(await seedSession('conversation'))).toBe(false);
    expect(await sessionAdmitsDurableDivert(`unknown_${newId()}`)).toBe(false);
  });

  it('a new issuance with identical response text remains a distinct practice occurrence', async () => {
    const f = await fixture();
    const first = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, {
      boss: { send: f.send },
    });
    const again = await issueSoloFixture(f.db, f.id, true);
    const second = await dispatchNativeAttempt(
      f.db,
      f.id,
      again.assessment('v+c=18，v-c=12。相加得2v=30，因此v=15 km/h。'),
      f.options,
      { boss: { send: f.send } },
    );
    expect(second).not.toBe(first);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(await pending(f.db)).toHaveLength(2);
  });

  it('pins the queue job ID to the run handle for marker-less recovery', async () => {
    const f = await fixture();
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, {
      boss: { send: f.send },
    });
    expect(run).toBeTruthy();
    if (!run) throw new Error('expected durable run ID');
    expect(f.send.mock.calls[0]?.[2]).toEqual({ id: judgeRunJobId(run) });
  });

  it.each(['throw', 'null'] as const)(
    'refunds admission on %s send failure; a different operation can use the token',
    async (failure) => {
      const f = await fixture();
      vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
      if (failure === 'throw') f.send.mockRejectedValue(new Error('boss down'));
      else f.send.mockResolvedValue(null);
      expect(
        await dispatchNativeAttempt(f.db, f.id, f.request, f.options, { boss: { send: f.send } }),
      ).toBeTruthy();
      const healthy = await fixture();
      expect(
        await dispatchNativeAttempt(healthy.db, healthy.id, healthy.request, healthy.options, {
          boss: { send: healthy.send },
        }),
      ).toBeTruthy();
      expect(healthy.send).toHaveBeenCalledTimes(1);
    },
  );

  it('does not refund after a successful enqueue; retries reuse the handle without paying admission twice', async () => {
    const f = await fixture();
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const run = await dispatchNativeAttempt(f.db, f.id, f.request, f.options, {
      boss: { send: f.send },
    });
    expect(
      await dispatchNativeAttempt(f.db, f.id, f.request, f.options, { boss: { send: f.send } }),
    ).toBe(run);
    expect(f.send).toHaveBeenCalledTimes(1);
    const next = await fixture();
    await expect(
      dispatchNativeAttempt(next.db, next.id, next.request, next.options, {
        boss: { send: next.send },
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(next.send).not.toHaveBeenCalled();
  });
});
