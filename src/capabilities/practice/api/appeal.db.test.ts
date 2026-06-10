import { event } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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

  it('writes appeal_request event and judge_retraction proposal chained to judge event', async () => {
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

    const [proposalEvt] = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:proposal'), eq(event.actor_ref, 'appeal')));
    expect(proposalEvt).toBeDefined();
    if (!proposalEvt) throw new Error('expected judge_retraction proposal event');
    expect(proposalEvt.subject_kind).toBe('event');
    expect(proposalEvt.subject_id).toBe(judgeEventId);
    const aiProposal = (proposalEvt.payload as { ai_proposal?: { kind?: string } }).ai_proposal;
    expect(aiProposal?.kind).toBe('judge_retraction');
  });

  it('returns 404 when judge_event_id not found', async () => {
    const res = await POST(makeReq({ judge_event_id: 'missing' }));
    expect(res.status).toBe(404);
  });

  it('returns 422 when judge_event_id points at a non-judge attempt event', async () => {
    const id = createId();
    await testDb()
      .insert(event)
      .values({
        id,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q-1',
        outcome: 'partial',
        payload: { judge: { route: 'steps', score: 0.4 } },
        caused_by_event_id: null,
      });
    const res = await POST(makeReq({ judge_event_id: id, reason_md: '步骤判错' }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: 'evidence_ref_must_be_judge_event' });
  });

  it('returns 422 when caused_by event is not a judge event', async () => {
    const id = createId();
    await testDb().insert(event).values({
      id,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'note_generate',
      action: 'note_generate',
      subject_kind: 'artifact',
      subject_id: 'a-1',
      outcome: 'success',
      payload: {},
      caused_by_event_id: null,
    });
    const res = await POST(makeReq({ judge_event_id: id }));
    expect(res.status).toBe(422);
  });

  it('returns 400 on invalid body', async () => {
    const res = await POST(makeReq({ wrong: 'shape' }));
    expect(res.status).toBe(400);
  });
});
