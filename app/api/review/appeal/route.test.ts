import { event } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './route';

async function seedJudgeEvent(): Promise<string> {
  const id = createId();
  await testDb().insert(event).values({
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

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/review/appeal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/review/appeal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes appeal_request event chained to judge event', async () => {
    const judgeEventId = await seedJudgeEvent();
    const res = await POST(makeReq({ judge_event_id: judgeEventId, reason_md: '我觉得对' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.appeal_event_id).toBeDefined();

    const [appealEvt] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, json.appeal_event_id));
    expect(appealEvt.action).toBe('experimental:appeal_request');
    expect(appealEvt.subject_kind).toBe('event');
    expect(appealEvt.subject_id).toBe(judgeEventId);
    expect(appealEvt.caused_by_event_id).toBe(judgeEventId);
    expect(appealEvt.actor_kind).toBe('user');
    expect((appealEvt.payload as { reason_md: string }).reason_md).toBe('我觉得对');
  });

  it('returns 404 when judge_event_id not found', async () => {
    const res = await POST(makeReq({ judge_event_id: 'missing' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when caused_by event is not a judge event', async () => {
    const id = createId();
    await testDb().insert(event).values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-1',
      outcome: 'success',
      payload: {},
      caused_by_event_id: null,
    });
    const res = await POST(makeReq({ judge_event_id: id }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid body', async () => {
    const res = await POST(makeReq({ wrong: 'shape' }));
    expect(res.status).toBe(400);
  });
});
