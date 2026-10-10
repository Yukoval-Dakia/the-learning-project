import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { job_events } from '@/db/schema';
import { Placement, Review } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PlacementSessionTransitionResponseSchema } from './placement-contracts';
import { PATCH as patchPlacementSession } from './placement-session-detail';
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

  it('replays a terminal placement target without a duplicate event', async () => {
    const { sessionId } = await Placement.startPlacementSession(testDb());
    const path = `/api/placement-sessions/${sessionId}`;

    const first = await patchPlacementSession(patchRequest(path, 'completed'), { id: sessionId });
    const replay = await patchPlacementSession(patchRequest(path, 'completed'), { id: sessionId });
    const firstBody = await first.json();
    const replayBody = await replay.json();
    expect(firstBody).toMatchObject({ status: 'completed', changed: true });
    expect(replayBody).toMatchObject({ status: 'completed', changed: false });
    expect(PlacementSessionTransitionResponseSchema.safeParse(firstBody).success).toBe(true);
    expect(PlacementSessionTransitionResponseSchema.safeParse(replayBody).success).toBe(true);

    const events = await testDb()
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, sessionId));
    expect(events.filter((event) => event.event_type === 'placement.completed')).toHaveLength(1);
  });
});
