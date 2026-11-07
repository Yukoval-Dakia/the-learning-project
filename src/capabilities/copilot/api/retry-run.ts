import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH } from '../server/durable-dispatch';
import { retryCopilotRun } from '../server/run-retry';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const key = req.headers.get('Idempotency-Key')?.trim();
    if (!key || key.length > COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new ApiError('validation_error', 'A valid Idempotency-Key is required', 400);
    }
    const accepted = await retryCopilotRun(db, params.id ?? '', key, {
      boss: await getStartedBoss(),
      transactionDb: fromPgBossDrizzleTx,
    });
    return Response.json(
      {
        run_id: accepted.runId,
        session_id: accepted.sessionId,
        derivation_policy: accepted.derivationPolicy ?? 'allow',
      },
      {
        status: 202,
        headers: { Location: `/api/jobs/copilot_run/${encodeURIComponent(accepted.runId)}/events` },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
