import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { ModelUnitOutcome } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { ai_task_runs, event } from '@/db/schema';

export const PhotoExamIdentity = z
  .object({
    task_kind: z.enum(['AssessmentRuleJudgeTask', 'AssessmentRubricJudgeTask']),
    model: z.string().min(1),
    model_version: z.string().min(1),
    provider: z.string().min(1),
  })
  .strict();
export const PhotoExamEvidence = z
  .object({
    version: z.literal(1),
    dry_run: z.literal(true),
    run_id: z.string().min(1),
    request_digest: z.string().min(1),
    identity: PhotoExamIdentity,
    items: z
      .array(
        z.object({
          item_id: z.string().min(1),
          dispatch: z.enum(['not_started', 'returned', 'unknown']),
          answer_class: z.enum(['correct', 'equivalent', 'wrong', 'partial', 'poor_clarity']),
          input_digest: z.string().min(1),
          reference_points: z.number().min(0),
          max_points: z.number().positive(),
          outcome: ModelUnitOutcome,
        }),
      )
      .min(24)
      .max(30),
    identity_stable: z.boolean(),
    passed: z.boolean(),
    digest: z.string().min(1),
  })
  .strict();

export function photoExamReferencesValid(
  items: ReadonlyArray<
    Pick<
      z.infer<typeof PhotoExamEvidence>['items'][number],
      'answer_class' | 'reference_points' | 'max_points'
    >
  >,
): boolean {
  if (
    ['correct', 'equivalent', 'wrong', 'partial', 'poor_clarity'].some(
      (kind) => !items.some((item) => item.answer_class === kind),
    )
  )
    return false;
  if (
    items.some(
      (item) =>
        (item.answer_class === 'wrong' && item.reference_points !== 0) ||
        ((item.answer_class === 'correct' || item.answer_class === 'equivalent') &&
          item.reference_points !== item.max_points) ||
        (item.answer_class === 'partial' &&
          (item.reference_points <= 0 || item.reference_points >= item.max_points)),
    )
  )
    return false;
  return true;
}

export function photoExamPasses(items: z.infer<typeof PhotoExamEvidence>['items']): boolean {
  if (!photoExamReferencesValid(items)) return false;
  return (
    items.filter((item) => item.outcome.kind === 'scored' && item.outcome.points_awarded !== null)
      .length *
      2 >=
      items.length &&
    !items.some(
      (item) =>
        item.reference_points < item.max_points &&
        item.outcome.kind === 'scored' &&
        item.outcome.points_awarded !== null &&
        item.outcome.points_awarded >= item.max_points,
    )
  );
}

/** Recompute the bar and bind each completed response to the recorded provider identity. */
export async function readVerifiedPhotoExam(
  db: Db,
  evidenceRef: string,
  identity: z.infer<typeof PhotoExamIdentity>,
  appliedReasoning?: string,
) {
  const [row] = await db.select().from(event).where(eq(event.id, evidenceRef)).limit(1);
  const parsed = PhotoExamEvidence.safeParse(row?.payload);
  if (
    row?.action !== 'experimental:photo_judge_exam' ||
    row.actor_kind !== 'system' ||
    row.actor_ref !== 'practice:photo-judge-exam' ||
    row.subject_kind !== 'model_admission_slice' ||
    row.outcome !== 'passed' ||
    !parsed.success
  )
    return null;
  const receipt = parsed.data;
  const { digest, ...body } = receipt;
  if (
    row.subject_id !== receipt.run_id ||
    evidenceRef !== `evt_photo_exam_${receipt.run_id}` ||
    canonicalHash(body) !== digest ||
    canonicalHash(identity) !== canonicalHash(receipt.identity) ||
    !receipt.identity_stable ||
    !receipt.passed ||
    !photoExamPasses(receipt.items)
  )
    return null;
  if (
    new Set(receipt.items.map((item) => item.item_id)).size !== receipt.items.length ||
    new Set(receipt.items.map((item) => item.input_digest)).size !== receipt.items.length
  )
    return null;
  const [start] = await db
    .select()
    .from(event)
    .where(eq(event.id, `evt_photo_exam_started_${receipt.run_id}`))
    .limit(1);
  if (
    start?.actor_kind !== 'system' ||
    start.actor_ref !== 'practice:photo-judge-exam' ||
    start.subject_kind !== 'model_admission_slice' ||
    start.subject_id !== receipt.run_id ||
    start.action !== 'experimental:photo_judge_exam_started' ||
    start.payload.request_digest !== receipt.request_digest ||
    canonicalHash(start.payload.identity) !== canonicalHash(identity)
  )
    return null;
  if (
    canonicalHash(start.payload.items) !==
    canonicalHash(receipt.items.map(({ outcome: _outcome, dispatch: _dispatch, ...item }) => item))
  )
    return null;
  const refs = receipt.items.flatMap((item) => item.outcome.run_refs);
  if (
    receipt.items.some(
      (item) =>
        item.reference_points > item.max_points ||
        (item.outcome.kind === 'scored' &&
          (item.outcome.run_refs.length === 0 ||
            item.outcome.points_awarded === null ||
            item.outcome.points_awarded > item.max_points)),
    )
  )
    return null;
  if (refs.length === 0 || new Set(refs).size !== refs.length) return null;
  if (receipt.items.some((item) => item.dispatch === 'unknown')) return null;
  if (!(await photoTaskRunsMatch(db, refs, identity, appliedReasoning))) return null;
  const scoredRefs = receipt.items.flatMap((item) =>
    item.outcome.kind === 'scored' ? item.outcome.run_refs.slice(-1) : [],
  );
  const scoredRuns = await db
    .select()
    .from(ai_task_runs)
    .where(inArray(ai_task_runs.id, scoredRefs));
  if (scoredRuns.some((run) => run.status !== 'success')) return null;
  return receipt;
}

/** Same ledger proof for an exam receipt and a just-completed formal photo call. */
export async function photoTaskRunsMatch(
  db: Db,
  refs: string[],
  identity: z.infer<typeof PhotoExamIdentity>,
  appliedReasoning?: string,
) {
  const runs = await db.select().from(ai_task_runs).where(inArray(ai_task_runs.id, refs));
  const usage = z.object({ reasoning: z.object({ applied: z.string().optional() }).optional() });
  return (
    runs.length === refs.length &&
    runs.every((run) => {
      const parsed = usage.safeParse(run.usage_json);
      return (
        run.task_kind === identity.task_kind &&
        run.provider === identity.provider &&
        run.model === identity.model &&
        ['success', 'failure'].includes(run.status) &&
        !!run.input_hash &&
        ['reported', 'estimated'].includes(run.cost_basis ?? '') &&
        run.cost_usd !== null &&
        parsed.success &&
        parsed.data.reasoning?.applied === appliedReasoning
      );
    })
  );
}
