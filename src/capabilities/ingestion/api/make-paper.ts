// POST /api/ingestion/[id]/make-paper.
//
// Packages a terminal imported session's questions into a takeable paper. This
// shell validates state, delegates to createIngestionPaper, and returns the
// artifact id. The body accepts only an optional question_ids list.

import { and, eq } from 'drizzle-orm';

import { createIngestionPaper } from '@/capabilities/ingestion/server/make-paper';
import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { MakePaperBody } from './operation-schema';

async function executePOST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    // Distinguish an empty body (no override) from malformed JSON. A broken body
    // must not silently build a full-set paper; return 400 instead.
    const rawText = await req.text();
    let raw: unknown;
    if (rawText.trim().length === 0) {
      raw = {};
    } else {
      try {
        raw = JSON.parse(rawText);
      } catch {
        throw new ApiError('invalid_json', 'request body is not valid JSON', 400);
      }
    }
    const parsed = MakePaperBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }

    // A paper can only be built from a committed import.
    const sessionRows = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
      .limit(1);
    const session = sessionRows[0] ?? null;
    if (!session) {
      throw new ApiError('not_found', `ingestion session ${sessionId} not found`, 404);
    }
    if (session.status !== 'imported') {
      throw new ApiError(
        'conflict',
        `ingestion session ${sessionId} is in status '${session.status}'; only 'imported' sessions can be made into a paper`,
        409,
      );
    }

    const { artifactId } = await createIngestionPaper(db, {
      sessionId,
      questionIds: parsed.data.question_ids,
    });

    return Response.json({ artifact_id: artifactId });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const successor = `/api/ingestion-sessions/${encodeURIComponent(params.id ?? '')}/operations`;
  return deprecatedRouteResponse(await executePOST(req, params), successor);
}
