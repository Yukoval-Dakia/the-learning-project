import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readQuestionCard } from '@/kernel/read-models/question-card';

import { QuestionCardQuerySchema } from './question-contracts';

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const query = QuestionCardQuerySchema.safeParse({
      session_id: new URL(req.url).searchParams.get('session_id') ?? undefined,
    });
    if (!query.success) throw new ApiError('validation_error', 'invalid session_id', 400);
    return Response.json(await readQuestionCard(db, params.id, query.data.session_id));
  } catch (error) {
    return errorResponse(error);
  }
}
