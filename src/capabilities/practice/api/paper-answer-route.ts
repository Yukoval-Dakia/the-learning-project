// U5 (YUK-203, §4.5) — POST /api/practice/[id]/answer: autosave a paper answer
// draft (upsert the live draft for the slot). `id` is the paper artifact id.
// The answering page calls this as the user types / advances between slots.

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { autosaveAnswerDraft } from '../server/answer-draft';

const AutosaveBody = z.object({
  session_id: z.string().min(1),
  question_id: z.string().min(1),
  part_ref: z.string().min(1).nullable().optional(),
  input_kind: z.enum(['text', 'option', 'image', 'voice']).default('text'),
  content_md: z.string().default(''),
  image_refs: z.array(z.string()).default([]),
});

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
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
    const { answerId } = await autosaveAnswerDraft(db, {
      sessionId: body.session_id,
      questionId: body.question_id,
      partRef: body.part_ref ?? null,
      inputKind: body.input_kind,
      contentMd: body.content_md,
      imageRefs: body.image_refs,
      paperArtifactId,
    });
    return Response.json({ answer_id: answerId });
  } catch (err) {
    return errorResponse(err);
  }
}
