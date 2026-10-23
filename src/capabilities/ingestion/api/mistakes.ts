import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { createManualMistake } from '../server/create-manual-mistake';
import { readMistakes } from '../server/mistakes-read';
import { CreateMistakeBodySchema } from './contracts';

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateMistakeBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const result = await createManualMistake(db, parsed.data, req.headers.get('Idempotency-Key'));
    return Response.json(result.body, {
      status: result.status,
      headers: {
        Location: result.location,
        ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// HTTP adaptation only; query policy belongs to the shared ingestion read operation.
export async function GET(req: Request): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(req.url).searchParams.entries()) raw[key] = value;
    return Response.json(await readMistakes(db, raw));
  } catch (err) {
    return errorResponse(err);
  }
}
