import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { job_events } from '@/db/schema';
import { Placement, Review, Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  PlacementSessionResponseSchema,
  PlacementSessionTransitionResponseSchema,
} from './placement-contracts';
import {
  GET as getPlacementSession,
  PATCH as patchPlacementSession,
} from './placement-session-detail';
import { PATCH as patchReviewSession } from './review-session-detail';
import { POST as legacyPause } from './session-pause';
import { GET as getSolveSession } from './solve-session-detail';

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

  it('exposes readable placement and solve session resources', async () => {
    const placement = await Placement.startPlacementSession(testDb(), {
      knowledgeIds: ['k1'],
    });
    const solve = await Tutor.startTutorSession(testDb(), { questionId: 'question_1' });

    const placementResponse = await getPlacementSession(
      new Request(`http://localhost/api/placement-sessions/${placement.sessionId}`),
      { id: placement.sessionId },
    );
    expect(placementResponse.status).toBe(200);
    const placementBody = await placementResponse.json();
    expect(placementBody).toMatchObject({
      id: placement.sessionId,
      type: 'placement',
      status: 'started',
    });
    expect(PlacementSessionResponseSchema.safeParse(placementBody).success).toBe(true);

    const solveResponse = await getSolveSession(
      new Request(`http://localhost/api/solve-sessions/${solve.sessionId}`),
      { sid: solve.sessionId },
    );
    expect(solveResponse.status).toBe(200);
    expect(await solveResponse.json()).toMatchObject({
      id: solve.sessionId,
      type: 'tutor',
      question_id: 'question_1',
    });
  });

  it('returns 404 for unknown placement and solve sessions', async () => {
    expect(
      (
        await getPlacementSession(new Request('http://localhost/api/placement-sessions/missing'), {
          id: 'missing',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await getSolveSession(new Request('http://localhost/api/solve-sessions/missing'), {
          sid: 'missing',
        })
      ).status,
    ).toBe(404);
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
