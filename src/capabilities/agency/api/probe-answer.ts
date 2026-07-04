// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S3) — probe answer route.
//
// The CONSUMER half of the dark-loop: the owner answers a served probe and this
// route closes the lifecycle. Isolated from the attempt/FSRS write path by
// construction (ND-5 red line):
//   - judge routing goes through `defaultJudgeKindForQuestion` → capability
//     registry `resolveJudge` → `runner.run()` PURE evaluation (no FSRS, no
//     attempt event, no θ̂). This is NOT submit.ts's `createDefaultJudgeInvoker`
//     path — that wrapper is attempt-domain-coupled; the isolated registry path
//     CANNOT physically reach the FSRS/attempt write.
//   - the only write is `answerProbe`, which writes exactly ONE
//     `experimental:probe_result` event (ND-5-confirmed in probe-lifecycle.ts).
//
// A5-a outcome→resolution split (spec §10 A5 option a; retire semantics moved
// INTO this wave from §8 defer):
//   judge coarse_outcome 'incorrect' → outcome=0 → resolution='confirmed'
//     (the learner erred on a discriminating probe → the conjecture's predicted
//     misconception is CONFIRMED; reconcile will mint the soft confused-with-X
//     state on the next nightly run).
//   judge coarse_outcome 'correct'   → outcome=1 → resolution='retired'
//     (the learner answered correctly → the conjecture is FALSIFIED; retire).
//
// Fail-closed (spec §6 S3): judge 'unsupported' (reference missing / kind
// mismatch) OR 'partial' (ambiguous on a discriminating probe) → 422, NO
// probe_result written, the probe stays served-but-unanswered. A partial does
// not discriminate cleanly; injecting ambiguous evidence into an n=1
// calibration anchor would poison the soft-track signal. The owner can re-answer
// (the slot is still active) or resolve via the admin reader (S4).

import { getDefaultRegistry } from '@/core/capability/judges';
import { JudgeKind, QuestionKind } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { answerProbe } from '../server/conjecture/probe-lifecycle';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

const AnswerBody = z.object({
  // owner's answer to the probe prompt (markdown). Required + non-empty: an empty
  // answer carries no signal and cannot be graded.
  answer_md: z.string().trim().min(1).max(10_000),
});

/**
 * Map the judge's coarse_outcome onto the probe lifecycle's (outcome, resolution)
 * pair. Returns null when the outcome is non-discriminating (partial / unsupported)
 * → caller fail-closes with a 422.
 *
 * 'incorrect'   → outcome=0 → 'confirmed'  (conjecture's predicted error observed)
 * 'correct'     → outcome=1 → 'retired'    (conjecture falsified)
 * 'partial'     → null                      (ambiguous → fail-closed)
 * 'unsupported' → null                      (judge cannot grade → fail-closed)
 */
function mapOutcome(
  coarse: JudgeResultV2T['coarse_outcome'],
): { outcome: 0 | 1; resolution: 'confirmed' | 'retired' } | null {
  switch (coarse) {
    case 'incorrect':
      return { outcome: 0, resolution: 'confirmed' };
    case 'correct':
      return { outcome: 1, resolution: 'retired' };
    case 'partial':
    case 'unsupported':
      return null;
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'probe question id is required', 400);
    }
    const probeQuestionId = parsedParams.data.id;

    const raw = await req.json().catch(() => null);
    const parsed = AnswerBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { answer_md: answerMd } = parsed.data;

    // Load the probe question row. Only `source='mind_probe'` rows are answerable
    // here — a non-probe question id is a 409 (this endpoint is conjecture-probe
    // scoped, NOT a general answer surface; regular submits go through /api/review/submit).
    const [probe] = await db
      .select()
      .from(question)
      .where(eq(question.id, probeQuestionId))
      .limit(1);
    if (!probe) {
      throw new ApiError('not_found', `probe question ${probeQuestionId} not found`, 404);
    }
    if (probe.source !== 'mind_probe') {
      throw new ApiError(
        'not_a_probe',
        `question ${probeQuestionId} is not a mind_probe (source='${probe.source}')`,
        409,
      );
    }

    // Isolated judge routing (ND-5): resolve the kind from the probe's structural
    // shape, resolve the capability runner from the registry, and call run() PURE.
    // This path never touches submit.ts / createDefaultJudgeInvoker / FSRS.
    //
    // The DB `kind` is a free-form text column; safeParse guards against a corrupt
    // / unknown kind landing here (fail-closed 422 rather than a judge crash).
    const kindParsed = QuestionKind.safeParse(probe.kind);
    if (!kindParsed.success) {
      throw new ApiError(
        'unsupported_judge_route',
        `probe ${probeQuestionId} has unknown question kind '${probe.kind}'`,
        422,
      );
    }
    const overrideParsed = probe.judge_kind_override
      ? JudgeKind.safeParse(probe.judge_kind_override)
      : null;
    if (probe.judge_kind_override && !overrideParsed) {
      throw new ApiError(
        'unsupported_judge_route',
        `probe ${probeQuestionId} has unknown judge_kind_override '${probe.judge_kind_override}'`,
        422,
      );
    }
    const judgeKind = defaultJudgeKindForQuestion({
      kind: kindParsed.data,
      judge_kind_override: overrideParsed?.data ?? null,
      rubric_json: probe.rubric_json,
    });
    const runner = getDefaultRegistry().resolveJudge(judgeKind);
    if (!runner) {
      throw new ApiError(
        'unsupported_judge_route',
        `judge kind '${judgeKind}' has no registered capability runner`,
        422,
      );
    }

    const judgeResult = await runner.run({
      question: probe as unknown as Record<string, unknown>,
      answer: { content: answerMd },
    });

    const mapped = mapOutcome(judgeResult.coarse_outcome);
    if (mapped === null) {
      // Fail-closed: NO probe_result written. The probe stays served-but-unanswered
      // (its slot is not consumed) so the owner can re-answer or resolve via admin.
      throw new ApiError(
        'unsupported_judge_route',
        `judge returned coarse_outcome='${judgeResult.coarse_outcome}' for probe ${probeQuestionId} (fail-closed: no probe_result written; probe stays active)`,
        422,
      );
    }

    const result = await answerProbe({
      db,
      probeQuestionId,
      outcome: mapped.outcome,
      resolution: mapped.resolution,
      answer_md: answerMd,
    });

    // The response reports the RECORDED outcome/resolution (from answerProbe),
    // NOT the current request's mapping — on an idempotent re-answer the recorded
    // values are faithful while the current judge call was NOT the basis. The
    // coarse_outcome field is informational about THIS call's judge verdict.
    return Response.json({
      status: result.status,
      resolution: result.status,
      outcome: result.outcome,
      probe_result_event_id: result.probe_result_event_id,
      coarse_outcome: judgeResult.coarse_outcome,
      idempotent: result.idempotent ?? false,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
