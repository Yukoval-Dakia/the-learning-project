import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { EventDetailResponseSchema } from './event-contracts';
import { GET } from './event-detail';

async function seedEvent({
  id,
  action = 'attempt',
  subjectKind = 'question',
  subjectId = 'q1',
  outcome = 'failure',
  causedBy = null,
}: {
  id: string;
  action?: string;
  subjectKind?: string;
  subjectId?: string;
  outcome?: string;
  causedBy?: string | null;
}): Promise<void> {
  const payload =
    action === 'attempt'
      ? { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] }
      : action === 'judge'
        ? {
            cause: {
              primary_category: 'concept',
              secondary_categories: [],
              analysis_md: '概念判断',
              confidence: 0.9,
            },
            referenced_knowledge_ids: [],
          }
        : {
            correction_kind: 'retract',
            reason_md: '记录有误',
            affected_refs: [{ kind: 'question', id: 'q1' }],
          };

  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: action === 'judge' ? 'agent' : 'user',
      actor_ref: action === 'judge' ? 'attribution' : 'self',
      action,
      subject_kind: subjectKind,
      subject_id: subjectId,
      outcome,
      payload,
      caused_by_event_id: causedBy,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-07-13T08:00:00Z'),
    });
}

async function getEvent(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/events/${id}`), { id });
}

describe('GET /api/events/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the focal event and downstream event chain', async () => {
    await seedEvent({ id: 'evt_attempt' });
    await seedEvent({
      id: 'evt_judge',
      action: 'judge',
      subjectKind: 'event',
      subjectId: 'evt_attempt',
      outcome: 'success',
      causedBy: 'evt_attempt',
    });

    const response = await getEvent('evt_attempt');
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(() => EventDetailResponseSchema.parse(json)).not.toThrow();
    const body = json as {
      event: { id: string; action: string; correction_status: { state: string } };
      correction_status: { state: string };
      chain: { caused_by: unknown; caused_events: Array<{ id: string }>; corrections: unknown[] };
    };
    expect(body.event).toMatchObject({ id: 'evt_attempt', action: 'attempt' });
    expect(body.correction_status).toEqual(body.event.correction_status);
    expect(body.chain.caused_by).toBeNull();
    expect(body.chain.caused_events.map((row) => row.id)).toEqual(['evt_judge']);
    expect(body.chain.corrections).toEqual([]);
  });

  it('separates correction events from ordinary downstream events', async () => {
    await seedEvent({ id: 'evt_attempt' });
    await seedEvent({
      id: 'evt_correction',
      action: 'correct',
      subjectKind: 'event',
      subjectId: 'evt_attempt',
      outcome: 'success',
      causedBy: 'evt_attempt',
    });

    const response = await getEvent('evt_attempt');
    const body = (await response.json()) as {
      correction_status: { state: string };
      chain: { caused_events: unknown[]; corrections: Array<{ id: string }> };
    };
    expect(body.correction_status.state).toBe('retracted');
    expect(body.chain.caused_events).toEqual([]);
    expect(body.chain.corrections.map((row) => row.id)).toEqual(['evt_correction']);
  });

  it('returns 404 for an unknown event', async () => {
    const response = await getEvent('missing_event');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('rejects an empty event id', async () => {
    const response = await GET(new Request('http://localhost/api/events/'), { id: '' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'validation_error' });
  });
});
