import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { acceptAskAnswer } from '../server/agent/asks';
import { IngestionAskAnswerBody, IngestionAskAnswerHeaders } from '../server/agent/contract';

/**
 * Accepts a learner answer for a durable ingest ask. The route validates and
 * accepts; the ask resolution and agent event commit in one tx. Replays are
 * idempotent, terminal asks return 409, and contract violations return 422. The
 * resume enqueue is post-commit best-effort; the sweeper re-dispatches if lost.
 */
export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const askId = params.ask_id;
    if (!sessionId || !askId) {
      throw new ApiError('validation_error', 'session id and ask id are required', 400);
    }

    const keyParse = IngestionAskAnswerHeaders.safeParse({
      'Idempotency-Key': req.headers.get('Idempotency-Key')?.trim() ?? '',
    });
    if (!keyParse.success) {
      throw new ApiError(
        'validation_error',
        'Idempotency-Key header is required (1–200 characters)',
        400,
      );
    }

    const raw = await req.json().catch(() => null);
    const parsed = IngestionAskAnswerBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }

    const result = await acceptAskAnswer(db, {
      sessionId,
      askId,
      idempotencyKey: keyParse.data['Idempotency-Key'],
      answer: parsed.data.answer,
    });
    return Response.json(result, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
