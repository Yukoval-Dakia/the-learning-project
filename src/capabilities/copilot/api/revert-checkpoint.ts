import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { requestCopilotCheckpointRevert } from '../server/checkpoint-revert-operation';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const outcome = await requestCopilotCheckpointRevert(db, params);

    return Response.json(outcome.body, { status: outcome.status });
  } catch (err) {
    return errorResponse(err);
  }
}
