// YUK-214 (Strategy D · S1) — POST /api/ingestion/[id]/make-paper.
//
// Explicit make-paper action (OWNER-FORK form (b), §13): package a session's
// imported questions into a tool_quiz paper so /practice can take them. Thin
// shell — validate the session is 'imported' (terminal), delegate to
// createIngestionPaper (reverse-query → build → INSERT), return { artifact_id }.
//
// Body is { question_ids? } ONLY (Cross-统合 F-9: outcome_filter cut — outcome
// lives on attempt events, not question rows; filtering by it is out of this
// thin shell's scope). Idempotent on sessionId via the module's advisory lock.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createIngestionPaper } from '@/server/ingestion/make-paper';

export const runtime = 'nodejs';

const MakePaperBody = z.object({
  // Optional explicit override of which imported questions to package. When
  // ABSENT (undefined), the module reverse-queries the session's imported
  // questions (default full-set). An EXPLICIT empty array is rejected: F3
  // (PR #309 round-3, YUK-214) — `question_ids: []` is an explicit empty
  // selection, NOT "select all", so it must 400 rather than silently fall
  // through to the full-set path. `.min(1)` enforces this at the schema layer;
  // `.optional()` keeps the omitted/undefined default-full-set path.
  question_ids: z.array(z.string().min(1)).min(1).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await params;
    // F2 (PR #309 round-2, YUK-214) — distinguish a TRULY-EMPTY body (no override
    // intended → default {}) from MALFORMED JSON (the caller meant to send
    // question_ids but the bytes are corrupt). Round-1 collapsed every parse
    // failure to `{}`, so a broken body silently built a default full-set paper
    // instead of surfacing the error. Read the raw text first: an empty/whitespace
    // body is the legitimate no-override case; a non-empty body that fails to
    // JSON.parse is a client error → 400 invalid_json (no paper built).
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

    // Validate the session exists and is in the terminal 'imported' state —
    // a paper can only be built from a committed import.
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
