import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Review from '@/capabilities/practice/server/review-session-lifecycle';
import { job_events } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PATCH as patchReviewSession } from './review-session-detail';

function patchRequest(path: string, status: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

describe('canonical review and placement session state', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('replays the same review target as a no-op without a duplicate event', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const path = `/api/review-sessions/${sessionId}`;

    const first = await patchReviewSession(patchRequest(path, 'paused'), { id: sessionId });
    const replay = await patchReviewSession(patchRequest(path, 'paused'), { id: sessionId });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'paused', changed: true });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: 'paused', changed: false });

    const events = await testDb()
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, sessionId));
    expect(events.filter((event) => event.event_type === 'review.paused')).toHaveLength(1);
  });
});
