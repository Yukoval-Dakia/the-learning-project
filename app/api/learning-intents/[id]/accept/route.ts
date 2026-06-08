// Phase 2B — accept a learning intent proposal.
//
// POST /api/learning-intents/[id]/accept → materialize LearningItem hierarchy
// + artifact stubs + enqueue note_generate jobs. The proposal id is the event
// id returned by POST /api/learning-intents.

import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { LearningIntentError, acceptLearningIntent } from '@/server/orchestrator/learning_intent';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    if (!id) throw new ApiError('validation_error', 'proposal id is required', 400);

    let result: Awaited<ReturnType<typeof acceptLearningIntent>>;
    try {
      result = await acceptLearningIntent({ db, proposalId: id });
    } catch (err) {
      if (err instanceof LearningIntentError) {
        const code = err.code;
        const status =
          code === 'proposal_not_found' ? 404 : code === 'proposal_already_rated' ? 409 : 500;
        return Response.json({ error: code, message: err.message }, { status });
      }
      throw err;
    }

    // Enqueue async note_generate jobs (one per generated note artifact). Gated
    // by the shared shouldEnqueueBackgroundJobs() (YUK-239) so the test suite
    // doesn't accumulate pg-boss state (same posture as session_summary enqueue
    // in /api/review/sessions/[id]/end).
    let enqueued = 0;
    if (shouldEnqueueBackgroundJobs()) {
      try {
        const boss = await getStartedBoss();
        for (const artifactId of [...result.atomic_artifact_ids, ...result.long_artifact_ids]) {
          try {
            await boss.send('note_generate', { artifact_id: artifactId });
            enqueued += 1;
          } catch (err) {
            console.warn(`note_generate enqueue failed for artifact ${artifactId}:`, err);
          }
        }
      } catch (err) {
        console.warn(`note_generate enqueue failed for ${id}:`, err);
      }
    }

    return Response.json({ ...result, enqueued_note_generate_jobs: enqueued });
  } catch (err) {
    return errorResponse(err);
  }
}
