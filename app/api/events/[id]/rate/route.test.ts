import { event } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

async function seedGeneratedArtifact(id = 'gen_a1'): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'generate',
      subject_kind: 'artifact',
      subject_id: 'artifact_a1',
      outcome: 'success',
      payload: {
        artifact_kind: 'note',
        title: '之字用法小结',
        body_md: 'Generated note body',
        referenced_event_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: 1200,
      created_at: new Date('2026-05-17T00:00:00Z'),
    });
}

async function rateEvent(id: string, rating = 'accept'): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/events/${id}/rate`, {
      method: 'POST',
      body: JSON.stringify({ rating }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('POST /api/events/[id]/rate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a RateEvent chained to the target event', async () => {
    await seedGeneratedArtifact('gen_a1');

    const res = await rateEvent('gen_a1', 'accept');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate_event_id: string; idempotent: boolean };
    expect(body.rate_event_id).toMatch(/.+/);
    expect(body.idempotent).toBe(false);

    const rows = await testDb()
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'rate'),
          eq(event.subject_kind, 'event'),
          eq(event.caused_by_event_id, 'gen_a1'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe('gen_a1');
    expect(rows[0].payload).toMatchObject({ rating: 'accept' });
  });

  it('is idempotent for the same rating and rejects a conflicting one', async () => {
    await seedGeneratedArtifact('gen_a1');

    const first = await rateEvent('gen_a1', 'dismiss');
    expect(first.status).toBe(200);

    const second = await rateEvent('gen_a1', 'dismiss');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { idempotent: boolean };
    expect(secondBody.idempotent).toBe(true);

    const conflict = await rateEvent('gen_a1', 'accept');
    expect(conflict.status).toBe(409);
  });

  it('404s for unknown target events', async () => {
    const res = await rateEvent('missing', 'accept');
    expect(res.status).toBe(404);
  });
});
