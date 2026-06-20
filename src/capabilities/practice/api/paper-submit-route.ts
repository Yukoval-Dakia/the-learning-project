// U5 (YUK-203, §4.6) — POST /api/practice/[id]/submit: submit ONE paper slot.
// `id` is the paper artifact id. Per-slot, UI-sequential (Q6). Resolves the
// slot's assignment (primary knowledge + section feedback_policy) from the
// auditable plan SERVER-side — the client never supplies knowledge ids or the
// visibility policy. Writes attempt + independent judge events + FSRS upsert and
// freezes the draft via submitPaperSlot.
//
// Distinct from /api/review/submit (single-question FSRS流, untouched).

import { z } from 'zod';

import { resolveSlotAssignment } from '@/capabilities/practice/server/paper-sections';
import { submitPaperSlot } from '@/capabilities/practice/server/paper-submit';
import { Artifact } from '@/core/schema/index';
import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { eq } from 'drizzle-orm';

const SubmitBody = z.object({
  session_id: z.string().min(1),
  question_id: z.string().min(1),
  part_ref: z.string().min(1).nullable().optional(),
  answer_md: z.string(),
  image_refs: z.array(z.string()).default([]),
  // YUK-448 — wall-clock RT (ms) from slot reveal to submit. Mirrors the solo
  // /api/review/submit body (submit.ts:73). Stricter than the read-side
  // AttemptOnQuestion schema (.min(0).max(1h) vs bare int) — write-side validation
  // tightening only; absent = no RT data (0 is a real measurement).
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
});

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id: paperArtifactId } = params;
    const raw = await req.json().catch(() => null);
    const parsed = SubmitBody.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;

    // Load the paper + resolve the slot assignment from the auditable plan.
    const rows = await db.select().from(artifact).where(eq(artifact.id, paperArtifactId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiError('not_found', `paper artifact ${paperArtifactId} not found`, 404);
    }
    const paper = Artifact.parse(row);
    const slot = resolveSlotAssignment(paper.tool_state, body.question_id, body.part_ref ?? null);
    if (!slot) {
      throw new ApiError(
        'validation_error',
        `slot (question ${body.question_id}, part ${body.part_ref ?? '-'}) is not in paper ${paperArtifactId}`,
        400,
      );
    }

    const result = await submitPaperSlot(
      {
        sessionId: body.session_id,
        paperArtifactId,
        questionId: body.question_id,
        partRef: body.part_ref ?? null,
        answerMd: body.answer_md,
        answerImageRefs: body.image_refs,
        primaryKnowledgeId: slot.primaryKnowledgeId,
        secondaryKnowledgeIds: slot.secondaryKnowledgeIds,
        feedbackPolicy: slot.feedbackPolicy,
        // YUK-448 — thread RT into the attempt payload (capture only; NOT wired
        // into θ̂/p(L) SRT credit — paper path does not pass responseTimeMs today).
        latencyMs: body.latency_ms ?? undefined,
      },
      db,
    );

    // Derived visibility (§4.9). The independent judge event carries the gate;
    // the read layer derives 可见. The submit response echoes whether THIS slot's
    // feedback is immediately visible so the answering page can show the judge
    // panel or a "feedback buffered" placeholder.
    //
    // When visible_to_user:false, coarse_outcome and score are structurally
    // ABSENT — same discipline as the GET buffered variant (§4.9 server boundary).
    return Response.json(
      result.visibleToUser
        ? {
            attempt_event_id: result.attemptEventId,
            judge_event_id: result.judgeEventId,
            answer_id: result.answerId,
            visible_to_user: true,
            coarse_outcome: result.coarseOutcome,
            score: result.score,
          }
        : {
            attempt_event_id: result.attemptEventId,
            judge_event_id: result.judgeEventId,
            answer_id: result.answerId,
            visible_to_user: false,
            feedback_buffered: true,
          },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
