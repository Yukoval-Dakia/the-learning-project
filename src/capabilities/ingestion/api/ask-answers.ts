import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { answerIngestionAsk } from '../server/agent/asks';

/**
 * Accepts a learner answer for a durable ingest ask. The route validates and
 * accepts; the ask resolution and agent event commit in one tx. Replays are
 * idempotent, terminal asks return 409, and contract violations return 422. The
 * resume enqueue is post-commit best-effort; the sweeper re-dispatches if lost.
 */
export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const result = await answerIngestionAsk(db, params, req.headers.get('Idempotency-Key'), () =>
      req.json(),
    );
    return Response.json(result, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
