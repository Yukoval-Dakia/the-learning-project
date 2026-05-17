// ADR-0013 — POST /api/review/sessions creates a review session.

import { learning_session } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './route';

function req() {
  return new Request('http://localhost/api/review/sessions', { method: 'POST' });
}

describe('POST /api/review/sessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a learning_session(type=review, status=started)', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session_id: string };
    expect(body.session_id).toBeTruthy();

    const db = testDb();
    const rows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('review');
    expect(rows[0].status).toBe('started');
    expect(rows[0].ended_at).toBeNull();
  });

  it('returns a fresh session id each call', async () => {
    const a = (await (await POST()).json()) as { session_id: string };
    const b = (await (await POST()).json()) as { session_id: string };
    expect(a.session_id).not.toBe(b.session_id);

    const db = testDb();
    const rows = await db
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(and(eq(learning_session.type, 'review'), eq(learning_session.status, 'started')));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  // suppress unused-import lint
  void req;
});
