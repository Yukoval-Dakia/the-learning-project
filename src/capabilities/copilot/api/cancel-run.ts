import { ZodError } from 'zod';
import {
  type CancelCopilotRunStatus,
  requestCopilotRunCancellation,
} from '@/capabilities/copilot/server/copilot-run-cancellation';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { CopilotRunParamsSchema } from './contracts';

export interface CancelCopilotRunHandlerDeps {
  /** Wake the next accepted session turn after this cancellation commits. */
  wakeSession?: (sessionId: string) => Promise<unknown>;
}

function response(runId: string, status: CancelCopilotRunStatus): Response {
  return Response.json({ ok: true, run_id: runId, status });
}

/** Request cooperative cancellation of one accepted durable Copilot run. */
async function cancelCopilotRun(
  _req: Request,
  params: Record<string, string>,
  wakeSession: CancelCopilotRunHandlerDeps['wakeSession'],
): Promise<Response> {
  try {
    const { id: runId } = CopilotRunParamsSchema.parse(params);
    const status = await requestCopilotRunCancellation(db, runId, wakeSession);

    return response(runId, status);
  } catch (err) {
    if (err instanceof ZodError) {
      return errorResponse(
        new ApiError('validation_error', err.issues.map((issue) => issue.message).join('; '), 400),
      );
    }
    return errorResponse(err);
  }
}

export function buildCancelCopilotRunHandler(deps: CancelCopilotRunHandlerDeps = {}) {
  return (req: Request, params: Record<string, string>) =>
    cancelCopilotRun(req, params, deps.wakeSession);
}

/** Test seam; the manifest injects the production session wake. */
export const POST = buildCancelCopilotRunHandler();
