// GET /api/questions question-bank list. Authentication is enforced upstream.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readPracticeQuestionList } from '../server/question-list-read';

export async function GET(req: Request): Promise<Response> {
  try {
    return Response.json(await readPracticeQuestionList(db, new URL(req.url).searchParams));
  } catch (err) {
    return errorResponse(err);
  }
}
