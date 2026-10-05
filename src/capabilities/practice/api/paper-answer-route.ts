// U5 (YUK-203, §4.5) — POST /api/practice/[id]/answer: autosave a paper answer
// draft (upsert the live draft for the slot). `id` is the paper artifact id.
// The answering page calls this as the user types / advances between slots.

import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { answer, learning_session } from '@/db/schema';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { autosaveAnswerDraft } from '../server/answer-draft';
import { readPaperAssessmentBinding } from '../server/assessment/paper-issuance';
import { saveResponseDraft } from '../server/assessment/submit';
import { LegacyPaperAnswerDraftBodySchema } from './paper-contracts';

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
    const parsed = LegacyPaperAnswerDraftBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;
    const assessment = body.assessment;
    if (assessment) {
      const result = await db.transaction(async (tx) => {
        await tx
          .select({ id: learning_session.id })
          .from(learning_session)
          .where(eq(learning_session.id, body.session_id))
          .for('update');
        const binding = await readPaperAssessmentBinding(tx, body.session_id);
        const slot = binding?.slots.find(
          (slot) =>
            slot.question_id === body.question_id && slot.part_ref === (body.part_ref ?? null),
        );
        if (
          binding?.paper_id !== paperArtifactId ||
          !slot ||
          slot.issuance_id !== assessment.issuance_id ||
          slot.evaluation_group_id !== assessment.evaluation_group_id ||
          slot.idempotency_key !== assessment.idempotency_key
        ) {
          throw new ApiError('coordinate_mismatch', 'draft does not match issued paper slot', 409);
        }
        const saved = await saveResponseDraft(tx, {
          issuance_id: assessment.issuance_id,
          evaluation_group_ref: assessment.evaluation_group_id,
          response_set: assessment.response_set,
          group_evidence: assessment.group_evidence,
          expected_save_epoch: body.expected_save_epoch,
        });
        if (saved.status !== 'saved')
          throw new ApiError(saved.status, 'paper draft was not saved', 409);
        const capture = await autosaveAnswerDraft(tx, {
          sessionId: body.session_id,
          questionId: body.question_id,
          partRef: body.part_ref ?? null,
          inputKind: body.input_kind,
          contentMd: body.content_md,
          imageRefs: body.image_refs,
          paperArtifactId,
        });
        return {
          answer_id: capture.answerId,
          created: capture.created,
          save_epoch: saved.save_epoch,
        };
      });
      return Response.json(result);
    }
    throw new ApiError(
      'historical_unknown',
      'paper draft requires its original assessment binding',
      409,
    );
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
