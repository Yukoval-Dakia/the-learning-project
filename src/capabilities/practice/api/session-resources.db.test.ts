import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { job_events } from '@/db/schema';
import { Placement, Review } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PATCH as patchPlacementSession } from './placement-session-detail';
import { PATCH as patchReviewSession } from './review-session-detail';
import { POST as legacyPause } from './session-pause';

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

  it('returns 409 for an impossible review transition', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    await Review.completeReviewSession(testDb(), sessionId);

    const response = await patchReviewSession(
      patchRequest(`/api/review-sessions/${sessionId}`, 'paused'),
      { id: sessionId },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict' });
  });

  it('replays a terminal placement target without a duplicate event', async () => {
    const { sessionId } = await Placement.startPlacementSession(testDb());
    const path = `/api/placement-sessions/${sessionId}`;

    const first = await patchPlacementSession(patchRequest(path, 'completed'), { id: sessionId });
    const replay = await patchPlacementSession(patchRequest(path, 'completed'), { id: sessionId });
    expect(await first.json()).toMatchObject({ status: 'completed', changed: true });
    expect(await replay.json()).toMatchObject({ status: 'completed', changed: false });

    const events = await testDb()
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, sessionId));
    expect(events.filter((event) => event.event_type === 'placement.completed')).toHaveLength(1);
  });

  it('marks legacy command paths as deprecated without changing their body', async () => {
    const { sessionId } = await Review.startReviewSession(testDb());
    const response = await legacyPause(new Request('http://localhost/legacy', { method: 'POST' }), {
      id: sessionId,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'paused' });
    expect(response.headers.get('deprecation')).toBe('@1783987200');
    expect(response.headers.get('link')).toBe(
      `</api/review-sessions/${sessionId}>; rel="successor-version"`,
    );
  });
});
