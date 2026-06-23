// YUK-491 — the appeal → rejudge enqueue must carry the singleton DEDUP window,
// not a bare singletonKey. On a standard-policy queue (rejudge is created via
// `createJobQueue(boss, 'rejudge', EXPIRE_LLM)` = no policy), pg-boss v12 only
// engages the policy-INDEPENDENT partial-unique index (`job_i4`) when
// `singleton_on IS NOT NULL`, which is populated ONLY when `singletonSeconds` is
// passed. A bare `singletonKey` is therefore a NO-OP. This test pins the send's
// dedup OPTIONS (the `singletonSeconds` arg) so the producer can't silently
// regress to a bare, inert `singletonKey`. It verifies the send SHAPE, not
// pg-boss's runtime dedup behavior (boss is mocked) — same scope as
// docx.db.test's AUTO_ENROLL_SINGLETON_SECONDS assertion (YUK-486).
//
// db partition: real Postgres for the event row writeEvent needs; boss + the
// enqueue gate are mocked so the send actually fires (the other appeal tests run
// with shouldEnqueueBackgroundJobs() false and never reach the send).

import { event } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const bossSend = vi.fn(async () => 'rejudge-job-1');
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: async () => ({ send: bossSend }),
}));

// Force the enqueue branch on; preserve the module's other exports.
vi.mock('@/server/runtime-env', async (orig) => ({
  ...(await orig<typeof import('@/server/runtime-env')>()),
  shouldEnqueueBackgroundJobs: () => true,
}));

// Import the route + the dedup-window constant AFTER the mocks.
import { REJUDGE_SINGLETON_SECONDS } from '@/capabilities/practice/jobs/rejudge-config';
import { POST } from './appeal';

async function seedJudgeEvent(): Promise<string> {
  const id = createId();
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'judge_runner',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'attempt-evt-1',
      outcome: 'success',
      payload: { coarse_outcome: 'partial' },
      caused_by_event_id: 'attempt-evt-1',
    });
  return id;
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/review/appeal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/review/appeal — rejudge enqueue dedup (YUK-491)', () => {
  beforeEach(async () => {
    await resetDb();
    bossSend.mockClear();
  });

  it('sends rejudge with singletonKey AND singletonSeconds (dedup actually engages)', async () => {
    const judgeEventId = await seedJudgeEvent();
    const res = await POST(makeReq({ judge_event_id: judgeEventId, reason_md: '我觉得对' }));
    expect(res.status).toBe(200);
    const { appeal_event_id } = (await res.json()) as { appeal_event_id: string };

    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith(
      'rejudge',
      { appeal_event_id },
      { singletonKey: appeal_event_id, singletonSeconds: REJUDGE_SINGLETON_SECONDS },
    );

    // The appeal event really landed (singletonKey is its id, so dedup is keyed
    // on a row that exists).
    const [appealEvt] = await testDb().select().from(event).where(eq(event.id, appeal_event_id));
    expect(appealEvt.action).toBe('experimental:appeal_request');
  });
});
