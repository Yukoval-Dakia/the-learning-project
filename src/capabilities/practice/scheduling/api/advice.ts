import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { previewReviewAdvice } from '../server/advice-operation';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    return Response.json(await previewReviewAdvice(db, raw, req.signal));
  } catch (err) {
    return errorResponse(err);
  }
}
