// U5 (YUK-203, §4.5) — POST /api/practice/[id]/answer: autosave a paper answer
// draft (upsert the live draft for the slot). `id` is the paper artifact id.
// The answering page calls this as the user types / advances between slots.

import { z } from 'zod';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { answer } from '@/db/schema';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { autosaveAnswerDraft } from '../server/answer-draft';

const AutosaveBody = z.object({
  session_id: z.string().min(1),
  question_id: z.string().min(1),
  part_ref: z.string().min(1).nullable().optional(),
  input_kind: z.enum(['text', 'option', 'image', 'voice']).default('text'),
  content_md: z.string().default(''),
  image_refs: z.array(z.string()).default([]),
});

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const rows = await db
      .select({
        id: answer.id,
        session_id: answer.session_id,
        question_id: answer.question_id,
        part_ref: answer.part_ref,
        input_kind: answer.input_kind,
        content_md: answer.content_md,
        image_refs: answer.image_refs,
        paper_artifact_id: answer.paper_artifact_id,
        autosaved_at: answer.autosaved_at,
        submitted_at: answer.submitted_at,
        event_id: answer.event_id,
      })
      .from(answer)
      .where(and(eq(answer.id, params.answerId), eq(answer.session_id, params.id)))
      .limit(1);
    const draft = rows[0];
    if (!draft) {
      throw new ApiError('not_found', `answer draft ${params.answerId} not found`, 404);
    }
    return Response.json(draft);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createAnswerDraft(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id: paperArtifactId } = params;
    const raw = await req.json().catch(() => null);
    const parsed = AutosaveBody.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;
    const { answerId, created } = await autosaveAnswerDraft(db, {
      sessionId: body.session_id,
      questionId: body.question_id,
      partRef: body.part_ref ?? null,
      inputKind: body.input_kind,
      contentMd: body.content_md,
      imageRefs: body.image_refs,
      paperArtifactId,
    });
    return Response.json({ answer_id: answerId, created });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const body = (await req
    .clone()
    .json()
    .catch(() => null)) as { session_id?: unknown } | null;
  const successor =
    typeof body?.session_id === 'string' && body.session_id.length > 0
      ? `/api/review-sessions/${body.session_id}/answer-drafts`
      : '/api/review-sessions';
  return deprecatedRouteResponse(await createAnswerDraft(req, params), successor);
}
