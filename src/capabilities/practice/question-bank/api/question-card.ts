import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readQuestionCard } from '@/kernel/read-models/question-card';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readQuestionCard(db, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
