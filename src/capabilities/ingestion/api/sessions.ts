import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { createIngestionSession } from '../server/create-session';
import { readIngestionSessions } from '../server/session-list-read';
import { CreateIngestionSessionBody } from './contracts';

export async function GET(req: Request): Promise<Response> {
  try {
    return Response.json(await readIngestionSessions(db, new URL(req.url).searchParams));
  } catch (err) {
    return errorResponse(err);
  }
}

// The asset cap is the PDF page cap, imported from the single source so the two
// cannot drift. The pipeline is length-driven, so raising the ceiling is safe.
/**
 * Creates an ingestion session in 'uploaded'; extraction is a separate async call
 * observed over SSE. This route writes no blocks and returns no extraction output.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateIngestionSessionBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await createIngestionSession(
      db,
      parsed.data,
      req.headers.get('Idempotency-Key'),
    );
    return Response.json(result.body, {
      status: result.status === 201 ? 200 : result.status,
      headers: {
        Location: result.location,
        ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Canonical POST /api/ingestion-sessions resource contract. */
export async function createIngestionSessionResource(req: Request): Promise<Response> {
  const response = await POST(req);
  if (!response.ok) return response;
  return new Response(response.body, { status: 201, headers: response.headers });
}

export async function legacyListIngestionSessions(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await GET(req), '/api/ingestion-sessions');
}

export async function legacyCreateIngestionSession(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await POST(req), '/api/ingestion-sessions');
}
