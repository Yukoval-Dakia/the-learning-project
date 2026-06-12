import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './event-correct';

async function seedAttempt(id = 'evt_target'): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-19T00:00:00Z'),
    });
}

async function correctEvent(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/events/${id}/correct`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { id },
  );
}

const VALID_RETRACT_BODY = {
  correction_kind: 'retract',
  reason_md: 'wrong event',
  affected_refs: [{ kind: 'question', id: 'q1' }],
};

describe('POST /api/events/[id]/correct', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects missing reason_md', async () => {
    await seedAttempt();

    const res = await correctEvent('evt_target', {
      correction_kind: 'retract',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('reason_md');
  });

  it('rejects supersede without replacement_event_id', async () => {
    await seedAttempt();

    const res = await correctEvent('evt_target', {
      correction_kind: 'supersede',
      reason_md: 'replace this event',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('replacement_event_id');
  });

  it('rejects replacement_event_id for non-supersede corrections', async () => {
    await seedAttempt();

    const res = await correctEvent('evt_target', {
      correction_kind: 'restore',
      replacement_event_id: 'evt_replacement',
      reason_md: 'restore should not point at a replacement',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('only allowed');
  });

  it('404s when the target event does not exist', async () => {
    const res = await correctEvent('missing_event', VALID_RETRACT_BODY);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('writes a CorrectEvent chained to the target event and returns its id', async () => {
    await seedAttempt();

    const res = await correctEvent('evt_target', VALID_RETRACT_BODY);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { correction_event_id: string };
    expect(body.correction_event_id).toMatch(/.+/);

    const rows = await testDb().select().from(event).where(eq(event.id, body.correction_event_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('correct');
    expect(rows[0].subject_kind).toBe('event');
    expect(rows[0].subject_id).toBe('evt_target');
    expect(rows[0].caused_by_event_id).toBe('evt_target');
    expect(rows[0].payload).toMatchObject(VALID_RETRACT_BODY);
  });

  it('writes supersede correction with replacement_event_id', async () => {
    await seedAttempt('evt_target');
    await seedAttempt('evt_replacement');

    const res = await correctEvent('evt_target', {
      correction_kind: 'supersede',
      replacement_event_id: 'evt_replacement',
      reason_md: 'replace with corrected event',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { correction_event_id: string };
    const rows = await testDb().select().from(event).where(eq(event.id, body.correction_event_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      correction_kind: 'supersede',
      replacement_event_id: 'evt_replacement',
    });
  });

  it('writes restore correction without replacement_event_id', async () => {
    await seedAttempt();

    const res = await correctEvent('evt_target', {
      correction_kind: 'restore',
      reason_md: 'reactivate event',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { correction_event_id: string };
    const rows = await testDb().select().from(event).where(eq(event.id, body.correction_event_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ correction_kind: 'restore' });
  });
});
