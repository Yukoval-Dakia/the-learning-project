import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import { canonicalHash } from '@/core/migration/canonical';
import {
  GroupEvidence,
  type ModelExecutorRequest,
  type ModelUnitOutcomeT,
  QuestionPart,
  ResponseSlot,
  ScoringUnit,
  SharedMaterial,
  SlotResponse,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { withModelSliceAdmissionLock } from '@/kernel/locks/grading';
import { resolveTaskBinding, resolveTaskReasoning } from '@/server/ai/providers';
import { admissionCallWindowMs } from '../jobs/model_slice_admission_run';
import { createAdmissionRunExecutor } from './judge/evaluate-submission';
import { currentModelPinForKind } from './model-slice-registry';
import {
  PhotoExamEvidence,
  PhotoExamIdentity,
  photoExamPasses,
  photoExamReferencesValid,
  readVerifiedPhotoExam,
} from './photo-exam-evidence';

export const PhotoJudgeExamInput = z
  .object({
    run_id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    dry_run: z.literal(true),
    identity: PhotoExamIdentity,
    materials_digest: z.string().min(1),
    max_cost_usd_micros: z.number().int().positive().max(3_000_000),
    per_item_max_cost_usd_micros: z.number().int().positive(),
    items: z
      .array(
        z
          .object({
            item_id: z.string().min(1),
            answer_class: z.enum(['correct', 'equivalent', 'wrong', 'partial', 'poor_clarity']),
            reference_points: z.number().min(0),
            unit: ScoringUnit,
            question_parts: z.array(QuestionPart),
            response_slots: z.array(ResponseSlot),
            slot_responses: z.array(SlotResponse),
            group_evidence: z.array(GroupEvidence),
            materials: z.array(SharedMaterial),
          })
          .strict(),
      )
      .min(24)
      .max(30),
  })
  .strict();

export function photoJudgeExamConfiguration(
  taskKind: 'AssessmentRuleJudgeTask' | 'AssessmentRubricJudgeTask',
) {
  const pin = currentModelPinForKind(taskKind);
  if (!pin) throw new Error('Photo exam task pin unavailable');
  const route = resolveTaskBinding(taskKind);
  return {
    identity: { task_kind: taskKind, ...pin, provider: route.provider },
    reasoning: resolveTaskReasoning(taskKind, route.provider, route.model, route.reasoning),
  };
}

export async function verifyPhotoJudgeExam(
  db: Db,
  runId: string,
  taskKind: 'AssessmentRuleJudgeTask' | 'AssessmentRubricJudgeTask',
) {
  const configuration = photoJudgeExamConfiguration(taskKind);
  const evidence_ref = `evt_photo_exam_${runId}`;
  return {
    evidence_ref,
    verified:
      (await readVerifiedPhotoExam(
        db,
        evidence_ref,
        configuration.identity,
        configuration.reasoning?.applied,
      )) !== null,
  };
}

/** Freeze the staged asset ids and resolved task identity before buying any comparison. */
export function freezePhotoJudgeExamInput(raw: unknown) {
  const initial = PhotoJudgeExamInput.parse(raw);
  const configuration = photoJudgeExamConfiguration(initial.identity.task_kind);
  if (
    initial.identity.provider !== configuration.identity.provider ||
    initial.identity.model !== configuration.identity.model
  )
    throw new Error(
      'Photo exam expected route does not match the loaded route; never switch automatically',
    );
  return {
    ...initial,
    identity: configuration.identity,
    materials_digest: canonicalHash(initial.items),
  };
}

/** Fixed dry-run evidence lane. A started-but-unsealed run is never automatically repaid. */
export async function runPhotoJudgeExam(db: Db, raw: unknown) {
  const data = PhotoJudgeExamInput.parse(raw);
  const { materials_digest, ...unfrozen } = data;
  if (materials_digest !== canonicalHash(unfrozen.items))
    throw new Error('Photo exam frozen materials digest mismatch');
  if (new Set(data.items.map((item) => item.item_id)).size !== data.items.length)
    throw new Error('Duplicate photo exam item');
  for (const item of data.items) {
    if (
      item.unit.points === null ||
      item.unit.points <= 0 ||
      item.reference_points > item.unit.points ||
      ![
        ...item.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
        ...item.group_evidence.map((entry) => entry.evidence),
      ].some((evidence) => evidence.kind === 'image')
    )
      throw new Error(`Invalid photo exam item ${item.item_id}`);
  }
  const identity = () => {
    const pin = currentModelPinForKind(data.identity.task_kind);
    const route = resolveTaskBinding(data.identity.task_kind);
    if (
      !pin ||
      canonicalHash({ task_kind: data.identity.task_kind, ...pin, provider: route.provider }) !==
        canonicalHash(data.identity)
    )
      throw new Error('Photo exam task identity drifted');
  };
  const imageDigests = data.items.flatMap((item) =>
    [
      ...item.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
      ...item.group_evidence.map((entry) => entry.evidence),
    ]
      .filter((evidence) => evidence.kind === 'image')
      .map((evidence) => evidence.asset.digest),
  );
  if (new Set(imageDigests).size !== imageDigests.length)
    throw new Error('Photo exam must not duplicate image samples');
  identity();
  const id = `evt_photo_exam_${data.run_id}`,
    startId = `evt_photo_exam_started_${data.run_id}`,
    requestDigest = canonicalHash(data);
  return withModelSliceAdmissionLock(db, `photo-exam:${data.run_id}`, async () => {
    const [sealed] = await db.select().from(event).where(eq(event.id, id)).limit(1);
    if (sealed) {
      const result = PhotoExamEvidence.parse(sealed.payload);
      if (result.request_digest !== requestDigest)
        throw new Error('Photo exam immutable request conflict');
      return result;
    }
    const [started] = await db.select().from(event).where(eq(event.id, startId)).limit(1);
    if (started)
      throw new Error(
        'Photo exam outcome unknown; inspect task-run evidence, never auto-repay this run',
      );
    const frozenItems = data.items.map((item) => ({
      item_id: item.item_id,
      answer_class: item.answer_class,
      input_digest: canonicalHash({
        slot_responses: item.slot_responses,
        group_evidence: item.group_evidence,
      }),
      reference_points: item.reference_points,
      max_points: item.unit.points ?? 0,
    }));
    if (!photoExamReferencesValid(frozenItems))
      throw new Error('Photo exam requires valid frozen references across all five answer classes');
    await writeEvent(db, {
      id: startId,
      actor_kind: 'system',
      actor_ref: 'practice:photo-judge-exam',
      action: 'experimental:photo_judge_exam_started',
      subject_kind: 'model_admission_slice',
      subject_id: data.run_id,
      outcome: null,
      payload: { request_digest: requestDigest, identity: data.identity, items: frozenItems },
      created_at: new Date(),
      ingest_at: new Date(),
    });
    const items: z.infer<typeof PhotoExamEvidence>['items'] = [];
    let reserved = 0;
    let firstImageFailed = false;
    for (const item of data.items) {
      let outcome: ModelUnitOutcomeT;
      let dispatch: 'not_started' | 'returned' | 'unknown' = 'not_started';
      try {
        identity();
        if (firstImageFailed)
          throw new Error(
            'First photo did not produce a judgment; stop and inspect route image support before further calls',
          );
        if (reserved + data.per_item_max_cost_usd_micros > data.max_cost_usd_micros)
          throw new Error('Photo exam total reservation exhausted');
        reserved += data.per_item_max_cost_usd_micros;
        const budget = resolveTaskBudget(data.identity.task_kind);
        const port = createAdmissionRunExecutor(
          db,
          data.identity.task_kind,
          Date.now() + admissionCallWindowMs(data.identity.task_kind, budget.timeout),
          data.per_item_max_cost_usd_micros,
        );
        if (!port) throw new Error('Photo exam executor missing');
        // Reference scores stay outside the model request.
        const request: ModelExecutorRequest = {
          submission_id: `photo_exam_${data.run_id}_${item.item_id}`,
          evaluation_group_id: `photo_exam_${data.run_id}`,
          revision_id: materials_digest,
          attempt: 1,
          scoring_unit_id: item.unit.scoring_unit_id,
          executor: {
            kind: 'model_executor',
            task_kind: data.identity.task_kind,
            admitted_slice_id: `photo_exam_${data.run_id}`,
            max_cost_usd_micros: data.per_item_max_cost_usd_micros,
          },
          unit: item.unit,
          question_parts: item.question_parts,
          response_slots: item.response_slots,
          slot_responses: item.slot_responses,
          group_evidence: item.group_evidence,
          materials: item.materials,
          spent_cost_usd_micros: reserved - data.per_item_max_cost_usd_micros,
        };
        dispatch = 'unknown';
        outcome = await port(request);
        dispatch = 'returned';
      } catch (error) {
        outcome = {
          kind: 'pending',
          pending: {
            reason: 'infra_failure',
            retryable: false,
            detail: error instanceof Error ? error.message : 'photo exam execution failed',
          },
          run_refs: [],
        };
      }
      if (items.length === 0) {
        console.info(
          'photo-exam-first-image',
          JSON.stringify({ run_id: data.run_id, item_id: item.item_id, outcome }),
        );
        if (outcome.kind !== 'scored') firstImageFailed = true;
      }
      if (outcome.cost_usd_micros !== undefined)
        reserved += Math.max(0, outcome.cost_usd_micros - data.per_item_max_cost_usd_micros);
      items.push({
        dispatch,
        item_id: item.item_id,
        answer_class: item.answer_class,
        input_digest: canonicalHash({
          slot_responses: item.slot_responses,
          group_evidence: item.group_evidence,
        }),
        reference_points: item.reference_points,
        max_points: item.unit.points ?? 0,
        outcome,
      });
    }
    let identityStable = true;
    try {
      identity();
    } catch {
      identityStable = false;
    }
    const body = {
      version: 1 as const,
      dry_run: true as const,
      run_id: data.run_id,
      request_digest: requestDigest,
      identity: data.identity,
      items,
      identity_stable: identityStable,
      passed: identityStable && photoExamPasses(items),
    };
    const normalized = PhotoExamEvidence.parse({ ...body, digest: 'unsealed' });
    const { digest: _unsealed, ...sealedBody } = normalized;
    const receipt = { ...normalized, digest: canonicalHash(sealedBody) };
    await writeEvent(db, {
      id,
      actor_kind: 'system',
      actor_ref: 'practice:photo-judge-exam',
      action: 'experimental:photo_judge_exam',
      subject_kind: 'model_admission_slice',
      subject_id: data.run_id,
      outcome: receipt.passed ? 'passed' : 'failed',
      payload: receipt,
      created_at: new Date(),
      ingest_at: new Date(),
    });
    const [readback] = await db.select().from(event).where(eq(event.id, id)).limit(1);
    if (canonicalHash(readback?.payload) !== canonicalHash(receipt))
      throw new Error('Photo exam receipt readback conflict');
    return receipt;
  });
}
