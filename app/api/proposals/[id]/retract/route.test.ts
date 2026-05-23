import { event } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { GET } from '../../route';
import { POST } from './route';

async function retractProposal(id: string, body: unknown = {}): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/proposals/${id}/retract`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('POST /api/proposals/[id]/retract', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a CorrectEvent and removes the proposal from the pending queue', async () => {
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

    const res = await retractProposal('learning_p1', { reason_md: 'bad suggestion' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; correction_event_id: string };
    expect(body.kind).toBe('retracted');
    expect(body.correction_event_id).toBeTruthy();

    const correctionRows = await db
      .select()
      .from(event)
      .where(eq(event.id, body.correction_event_id));
    expect(correctionRows).toHaveLength(1);
    expect(correctionRows[0].payload).toMatchObject({
      correction_kind: 'retract',
      reason_md: 'bad suggestion',
    });

    const pendingRes = await GET(new Request('http://localhost/api/proposals?status=pending'));
    const pending = (await pendingRes.json()) as { rows: unknown[] };
    expect(pending.rows).toEqual([]);
  });

  it('returns 404 for missing proposal', async () => {
    const res = await retractProposal('missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});
