import { ZodError } from 'zod';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { CopilotRunParamsSchema } from '../api/contracts';
import {
  type CancelCopilotRunStatus,
  requestCopilotRunCancellation,
} from './copilot-run-cancellation';

export async function cancelCopilotRun(
  db: Db,
  params: Record<string, string>,
  wakeSession?: (sessionId: string) => Promise<unknown>,
): Promise<{ ok: true; run_id: string; status: CancelCopilotRunStatus }> {
  try {
    const { id: runId } = CopilotRunParamsSchema.parse(params);
    const status = await requestCopilotRunCancellation(db, runId, wakeSession);
    return { ok: true, run_id: runId, status };
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ApiError(
        'validation_error',
        err.issues.map((issue) => issue.message).join('; '),
        400,
      );
    }
    throw err;
  }
}
