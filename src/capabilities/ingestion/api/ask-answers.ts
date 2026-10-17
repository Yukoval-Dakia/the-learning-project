import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { acceptAskAnswer } from '../server/agent/asks';
import { IngestionAskAnswerBody, IngestionAskAnswerHeaders } from '../server/agent/contract';

/**
 * YUK-1522 (R8) — POST /api/ingestion-sessions/[id]/asks/[ask_id]/answers
 *
 * Learner answer acceptance for a durable ingestion ask. The durable truth is
 * the ask.resolved + ingestion_agent.ask_resolved pair written in one tx;
 * this route only validates and accepts:
 *   - 202 {accepted:true, replayed:false} on first acceptance;
 *   - 202 {accepted:true, replayed:true} on same-key/same-content replay;
 *   - 409 idempotency_conflict on same-key/different-content;
 *   - 409 ask_already_resolved when the ask is terminal (answer or timeout);
 *   - 422 option_not_found / answer_empty / answer_too_long /
 *     answer_kind_mismatch per the contract.
 * The resume enqueue is post-commit best-effort; the ask sweeper re-dispatches
 * the durable resume_requested marker if the send is lost.
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
