import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { FailedTurnPracticeTargetQuery } from '../failed-turn-practice-target-contract';
import { readFailedTurnPracticeTarget } from '../server/failed-turn-practice-target';
import { CopilotRunParamsSchema } from './contracts';

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const run = CopilotRunParamsSchema.safeParse(params);
    const query = FailedTurnPracticeTargetQuery.safeParse({
      session_id: new URL(req.url).searchParams.get('session_id'),
    });
    if (!run.success || !query.success)
      throw new ApiError('validation_error', 'run and session are required', 400);
    return Response.json(
      await readFailedTurnPracticeTarget(db, { run_id: run.data.id, ...query.data }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
