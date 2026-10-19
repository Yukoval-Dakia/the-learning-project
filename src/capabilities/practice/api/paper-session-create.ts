import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { isPaperIntentSource } from '@/capabilities/practice/server/paper-intent-sources';
import { db } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { Review } from '@/server/session';
import {
  assertIssuedPaperSlotsRenderable,
  assertPaperOpenable,
  issuePaperAssessment,
  readPaperAssessmentBinding,
} from '../server/assessment/paper-issuance';

export interface PaperReviewSessionResult {
  sessionId: string;
  created: boolean;
}

/** Validate a paper and create or reuse its active review session. */
export async function createPaperReviewSession(paperId: string): Promise<PaperReviewSessionResult> {
  return db.transaction(async (tx) => {
    // A row lock cannot serialize the "no active session exists" case. Use a
    // transaction-scoped lock keyed by paper so concurrent creates cannot both
    // pass the empty lookup and insert separate active sessions.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paper-review-session:${paperId}`}, 0))`,
    );

    const artifactRows = await tx
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
    if (!isPaperIntentSource(paper.intent_source)) {
      throw new ApiError(
        'validation_error',
        `artifact ${paperId} is not a practice paper (intent_source=${paper.intent_source})`,
        400,
      );
    }

    const existingSessionRows = await tx
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(
        and(
          eq(learning_session.type, 'review'),
          eq(learning_session.artifact_id, paperId),
          inArray(learning_session.status, ['started', 'paused']),
        ),
      )
      .orderBy(desc(learning_session.created_at))
      .limit(1);
    if (existingSessionRows[0]) {
      // YUK-1573 — an occurrence opened before the whole-paper guard is not handed back
      // to the paper page when its issued slots include ones the page cannot render.
      const binding = await readPaperAssessmentBinding(tx, existingSessionRows[0].id);
      if (binding) {
        await assertIssuedPaperSlotsRenderable(
          tx,
          paperId,
          binding.slots.map((slot) => slot.issuance_id),
        );
      }
      return { sessionId: existingSessionRows[0].id, created: false };
    }

    // YUK-1573 — read-only refusal before the session row and any issuance are written.
    await assertPaperOpenable(tx, paperId);
    const { sessionId } = await Review.startReviewSession(tx, { artifactId: paperId });
    await issuePaperAssessment(tx, sessionId, paperId);
    return { sessionId, created: true };
  });
}
