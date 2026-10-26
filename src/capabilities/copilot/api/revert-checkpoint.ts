import { ZodError } from 'zod';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { revertCopilotCheckpoint } from '../server/checkpoint-revert-operation';
import { CopilotCheckpointParamsSchema } from './contracts';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { eventId: checkpointEventId } = CopilotCheckpointParamsSchema.parse(params);
    const outcome = await revertCopilotCheckpoint(db, checkpointEventId);

    return Response.json(outcome.body, { status: outcome.status });
  } catch (err) {
    // A bad path param is a 400 validation_error, not a generic 500 (a bare
    // errorResponse(ZodError) would fall through to 500).
    if (err instanceof ZodError) {
      return errorResponse(
        new ApiError('validation_error', err.issues.map((i) => i.message).join('; '), 400),
      );
    }
    return errorResponse(err);
  }
}
