// U5 (YUK-203, §4.10 Q8) — GET /api/practice: the 今日/往日 practice list
// aggregation (paper artifacts + linked review session + derived pos/right-
// wrong/gen). POST /api/practice: start a review session bound to a paper
// artifact (the answering page calls this on mount).
//
// Handler logic lives in server modules (Review.startReviewSession +
// getPracticeList) so the route module only exports recognized handlers
// (next build / YUK-67).

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getPracticeList } from '@/server/review/practice-read';
import { Review } from '@/server/session';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  try {
    const result = await getPracticeList(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const StartBody = z.object({
  artifact_id: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = StartBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'artifact_id is required', 400);
    }
    // Round-4 fix #3: validate artifact before starting a session.
    // Must exist, be a tool_quiz, have generation_status='ready', and use one
    // of the paper intent_sources used by the list query. Any other
    // artifact (failed generation, non-paper type) must not be able to start
    // a session — those sessions then pollute the paper linkage read paths.
    // YUK-214 (Strategy D · S1) — `ingestion_paper` is the fourth paper source
    // (ingest→practice bridge); must stay in lock-step with the list query
    // whitelist at practice-read.ts (§Step 1).
    const PAPER_INTENT_SOURCES = [
      'review_plan',
      'quiz_gen',
      'embedded_check',
      'ingestion_paper',
    ] as const;
    const artifactRows = await db
      .select({
        id: artifact.id,
        type: artifact.type,
        generation_status: artifact.generation_status,
        intent_source: artifact.intent_source,
      })
      .from(artifact)
      .where(eq(artifact.id, parsed.data.artifact_id))
      .limit(1);
    const art = artifactRows[0];
    if (!art) {
      throw new ApiError('not_found', `artifact ${parsed.data.artifact_id} not found`, 404);
    }
    if (art.type !== 'tool_quiz') {
      throw new ApiError(
        'validation_error',
        `artifact ${parsed.data.artifact_id} is not a practice paper (type=${art.type})`,
        400,
      );
    }
    if (art.generation_status !== 'ready') {
      throw new ApiError(
        'validation_error',
        `artifact ${parsed.data.artifact_id} is not ready (generation_status=${art.generation_status})`,
        400,
      );
    }
    if (
      !PAPER_INTENT_SOURCES.includes(art.intent_source as (typeof PAPER_INTENT_SOURCES)[number])
    ) {
      throw new ApiError(
        'validation_error',
        `artifact ${parsed.data.artifact_id} is not a practice paper (intent_source=${art.intent_source})`,
        400,
      );
    }

    // Round-6 fix #3 (CR 3359820518): reuse an existing started/paused session
    // for this artifact instead of creating a new one on every POST. Without this
    // guard, two concurrent tab opens would each create their own session; the
    // read layer takes only the newest, so the older session's answers would be
    // orphaned (FSRS already written, but invisible). Idempotent: return the
    // existing session id when one is active.
    const existingSessionRows = await db
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(
        and(
          eq(learning_session.type, 'review'),
          eq(learning_session.artifact_id, parsed.data.artifact_id),
          inArray(learning_session.status, ['started', 'paused']),
        ),
      )
      .orderBy(learning_session.created_at)
      .limit(1);
    if (existingSessionRows[0]) {
      return Response.json({ session_id: existingSessionRows[0].id });
    }

    const { sessionId } = await Review.startReviewSession(db, {
      artifactId: parsed.data.artifact_id,
    });
    return Response.json({ session_id: sessionId });
  } catch (err) {
    return errorResponse(err);
  }
}
