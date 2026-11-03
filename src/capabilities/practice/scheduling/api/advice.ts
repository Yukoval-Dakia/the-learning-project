import { isJudgeRunPending, durablePendingResponse } from '@/capabilities/practice/grading/public';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { previewReviewAdvice } from '../server/advice-operation';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const result = await previewReviewAdvice(db, raw, req.signal);
    if (isJudgeRunPending(result)) return durablePendingResponse(result);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
