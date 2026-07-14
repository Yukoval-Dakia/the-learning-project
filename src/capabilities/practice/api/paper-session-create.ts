import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { Review } from '@/server/session';

const PAPER_INTENT_SOURCES = [
  'review_plan',
  'quiz_gen',
  'embedded_check',
  'ingestion_paper',
] as const;

export interface PaperReviewSessionResult {
  sessionId: string;
  created: boolean;
}

/** Validate a paper and create or reuse its active review session. */
export async function createPaperReviewSession(paperId: string): Promise<PaperReviewSessionResult> {
  const artifactRows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      generation_status: artifact.generation_status,
      intent_source: artifact.intent_source,
    })
    .from(artifact)
    .where(eq(artifact.id, paperId))
    .limit(1);
  const paper = artifactRows[0];
  if (!paper) {
    throw new ApiError('not_found', `artifact ${paperId} not found`, 404);
  }
  if (paper.type !== 'tool_quiz') {
    throw new ApiError(
      'validation_error',
      `artifact ${paperId} is not a practice paper (type=${paper.type})`,
      400,
    );
  }
  if (paper.generation_status !== 'ready') {
    throw new ApiError(
      'validation_error',
      `artifact ${paperId} is not ready (generation_status=${paper.generation_status})`,
      400,
    );
  }
  if (
    !PAPER_INTENT_SOURCES.includes(paper.intent_source as (typeof PAPER_INTENT_SOURCES)[number])
  ) {
    throw new ApiError(
      'validation_error',
      `artifact ${paperId} is not a practice paper (intent_source=${paper.intent_source})`,
      400,
    );
  }

  const existingSessionRows = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'review'),
        eq(learning_session.artifact_id, paperId),
        inArray(learning_session.status, ['started', 'paused']),
      ),
    )
    .orderBy(learning_session.created_at)
    .limit(1);
  if (existingSessionRows[0]) {
    return { sessionId: existingSessionRows[0].id, created: false };
  }

  const { sessionId } = await Review.startReviewSession(db, { artifactId: paperId });
  return { sessionId, created: true };
}
