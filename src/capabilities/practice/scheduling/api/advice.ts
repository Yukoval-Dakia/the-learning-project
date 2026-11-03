import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { previewReviewAdvice } from '../server/advice-operation';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const result = await previewReviewAdvice(db, raw, req.signal);
    // Same status and Location as createAttempt's durable divert.
    if ('verdict' in result)
      return Response.json(result, { status: 202, headers: { Location: result.backfill.url } });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
