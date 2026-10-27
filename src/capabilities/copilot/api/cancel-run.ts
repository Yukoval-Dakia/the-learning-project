import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { cancelCopilotRun as cancelCopilotRunRequest } from '../server/run-cancel-request';

export interface CancelCopilotRunHandlerDeps {
  /** Wake the next accepted session turn after this cancellation commits. */
  wakeSession?: (sessionId: string) => Promise<unknown>;
}

/** Request cooperative cancellation of one accepted durable Copilot run. */
async function cancelCopilotRun(
  _req: Request,
  params: Record<string, string>,
  wakeSession: CancelCopilotRunHandlerDeps['wakeSession'],
): Promise<Response> {
  try {
    return Response.json(await cancelCopilotRunRequest(db, params, wakeSession));
  } catch (err) {
    return errorResponse(err);
  }
}

export function buildCancelCopilotRunHandler(deps: CancelCopilotRunHandlerDeps = {}) {
  return (req: Request, params: Record<string, string>) =>
    cancelCopilotRun(req, params, deps.wakeSession);
}

/** Test seam; the manifest injects the production session wake. */
export const POST = buildCancelCopilotRunHandler();
