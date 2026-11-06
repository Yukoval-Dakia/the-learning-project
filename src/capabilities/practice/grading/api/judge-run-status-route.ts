import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readJudgeRunStatus } from '../public';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    if (!params.id) throw new ApiError('validation_error', 'missing run id', 400);
    const read = await readJudgeRunStatus(db, params.id);
    if (read.kind === 'not_found') throw new ApiError('not_found', 'judge run not found', 404);
    if (read.kind === 'unavailable')
      throw new ApiError(
        'judge_status_unavailable',
        'judge status is temporarily unavailable',
        503,
      );
    return Response.json(read.value);
  } catch (error) {
    return errorResponse(error);
  }
}
