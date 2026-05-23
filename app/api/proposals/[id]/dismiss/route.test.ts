import { event } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

async function dismissProposal(id: string, body: unknown = {}): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/proposals/${id}/dismiss`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('POST /api/proposals/[id]/dismiss', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('dismisses a future proposal kind with a generic RateEvent', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
      },
    });

    const res = await dismissProposal('learning_p1', { user_note: 'not now' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; rate_event_id: string };
    expect(body.kind).toBe('dismissed');
    expect(body.rate_event_id).toBeTruthy();

    const rates = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'learning_p1')));
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({ rating: 'dismiss', user_note: 'not now' });
  });

  it('returns 404 for missing proposal', async () => {
    const res = await dismissProposal('missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});
