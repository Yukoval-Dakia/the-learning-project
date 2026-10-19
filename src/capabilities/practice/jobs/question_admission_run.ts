// YUK-1507 — one durable admission batch per group/base digest.
// The publisher event outbox enqueues pinned revisions. Queue retries replay a
// complete result receipt, never paid solves. Unknown batches require reconciliation.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { QUESTION_ADMISSION_POLICY_IDS } from '@/core/question-admission-policy';
import { findAnswerShapeDeclarations } from '@/core/schema/assessment/blank-answer-shape';
import { LEGACY_DRAFT_STATUS } from '@/core/schema/assessment/lifecycle';
import type { ResponseSpecT } from '@/core/schema/assessment/response';
import type { ScoringBasisT } from '@/core/schema/assessment/scoring';
import type { QuestionGroupStructureT } from '@/core/schema/assessment/structure';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
} from '@/db/paid-effect-control';
import {
  markPaidEffectUnknown,
  notePaidEffectApplicationFailure,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  settleExpiredPaidEffectSends,
} from '@/db/paid-effect-store';
import {
  knowledge,
  question,
  question_admission_verification,
  question_revision,
  source_asset,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  type NormalizedContract,
  type PartRow,
  normalizeQuestionGroupToContract,
  publishedContractSeal,
  publishedSealAccepts,
} from '@/kernel/records/assessment-normalization';
import { resolveSubjectProfile } from '@/subjects/profile';
import { type Provider, definitionFromContract } from '../server/admission';
import { runQuestionAdmissionChecks } from '../server/admission/checks';
import {
  ADMISSION_FAMILY,
  AdmissionJobData,
  isPendingAdmission,
  lockAdmissionGroup,
} from '../server/admission/enqueue';
import {
  type AdmissionDelivery,
  AdmissionResultReceipt,
  FrozenAdmissionInput,
  assertAdmissionDelivery,
  claimAdmissionBatch,
  completedAdmissionStatus,
} from '../server/admission/receipt';
import {
  resolveQuestionAdmissionPolicyId,
  runQuestionAdmission,
} from '../server/admission/run-admission';
import { canonicalQuestionContentHash } from '../server/quiz/content-fingerprint';
import { publishQuestionGroup } from '../server/quiz/verify-and-promote';
import { type PracticeTaskRunFn, makePracticeTaskTextRunFn } from '../server/task-runtime';

export type QuestionAdmissionRunData = AdmissionJobData;
export interface QuestionAdmissionRunResult {
  status: 'admitted' | 'withheld' | 'pending' | 'stale' | 'conflict' | 'already_verified';
  group_id: string;
  revision_id?: string;
  revision_ordinal?: number;
  per_unit: { scoring_unit_id: string; status: string; reason?: string }[];
}
const SOLVER2_PROVIDER = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER as Provider | undefined;
const SOLVER2_MODEL = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;

async function loadDefinition(db: Db | Tx, rootId: string) {
  const [root] = await db.select().from(question).where(eq(question.id, rootId)).limit(1);
  if (!root) throw new ApiError('not_found', `question '${rootId}' not found`, 404);
  const partRows = await db
    .select()
    .from(question)
    .where(eq(question.parent_question_id, root.id))
    .orderBy(question.part_index);
  const liveParts = partRows.filter((p) => {
    const meta = p.metadata as Record<string, unknown> | null;
    return meta?.archived_at == null && meta?.dismissed_at == null;
  });
  const figureAssetIds = new Set<string>();
  for (const f of root.figures ?? []) figureAssetIds.add(f.asset_id);
  for (const p of liveParts) for (const f of p.figures ?? []) figureAssetIds.add(f.asset_id);
  const figureDigests: Record<string, string> = {};
  if (figureAssetIds.size > 0) {
    const assets = await db
      .select({ assetId: source_asset.id, sha256: source_asset.sha256 })
      .from(source_asset)
      .where(inArray(source_asset.id, [...figureAssetIds]));
    for (const a of assets) figureDigests[a.assetId] = a.sha256;
  }
  return normalizeQuestionGroupToContract(
    { ...(root as Parameters<typeof normalizeQuestionGroupToContract>[0]), figureDigests },
    liveParts.map(
      (p): PartRow => ({
        id: p.id,
        kind: p.kind,
        judge_kind_override: p.judge_kind_override,
        metadata: p.metadata,
        prompt_md: p.prompt_md,
        reference_md: p.reference_md,
        choices_md: p.choices_md,
        structured: p.structured,
        figures: p.figures,
      }),
    ),
  );
}

type GradedContract = {
  contract: NormalizedContract;
  revision: typeof question_revision.$inferSelect | null;
  /** False when a current revision was required and its row is missing. */
  digestMatches: boolean;
};

/**
 * Grade the stored revision only when its digest is the canonical seal, or a
 * legacy seal recomputed from these stored layers (schema key order, or the
 * stored jsonb key order). A caller-order digest that matches none of those
 * is not graded.
 */
function sealedRevisionContract(revision: typeof question_revision.$inferSelect): {
  contract: NormalizedContract;
  digestMatches: boolean;
} {
  const seal = publishedContractSeal({
    structure: revision.structure,
    response_spec: revision.response_spec,
    scoring_basis: revision.scoring_basis,
    execution_plan: revision.execution_plan,
    ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
  });
  return {
    digestMatches: publishedSealAccepts(seal, revision.integrity_digest),
    contract: {
      ...seal.parsed,
      integrity_digest: revision.integrity_digest,
      group_id: revision.group_id,
      conversion_issues: [],
    },
  };
}

/**
 * Grade the published revision when one exists. The question row is a projection
 * and its rebuilt contract is a different document. A missing current revision,
 * or a stored layer whose digest no longer matches, is not graded.
 */
async function loadGradedContract(
  db: Db | Tx,
  rootId: string,
  currentRevisionId: string | null,
): Promise<GradedContract> {
  if (currentRevisionId == null) {
    return { contract: await loadDefinition(db, rootId), revision: null, digestMatches: true };
  }
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, currentRevisionId))
    .limit(1);
  if (!revision || revision.group_id !== rootId) {
    return { contract: await loadDefinition(db, rootId), revision: null, digestMatches: false };
  }
  try {
    const sealed = sealedRevisionContract(revision);
    return { revision, ...sealed };
  } catch {
    return { contract: await loadDefinition(db, rootId), revision, digestMatches: false };
  }
}

/** Same stem rule as submit's projectPrompt: a shared stem is the row prompt. */
function projectPromptMd(structure: QuestionGroupStructureT): string {
  const parts = structure.parts;
  if (parts.length === 1) return parts[0].prompt_md;
  const stem = parts
    .flatMap((part) => part.material_ids)
    .map((id) => structure.materials.find((material) => material.material_id === id))
    .find((material) => material != null && material.caption === 'stem/shared context');
  if (stem?.content_md != null) return stem.content_md;
  return parts
    .map((part) => part.prompt_md)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}

function projectAdmittedQuestionRow(contract: {
  structure: QuestionGroupStructureT;
  response_spec: ResponseSpecT;
  scoring_basis: ScoringBasisT;
}) {
  const parts = contract.structure.parts;
  const promptMd = projectPromptMd(contract.structure);
  const slotById = new Map(contract.response_spec.slots.map((slot) => [slot.slot_id, slot]));
  const references: string[] = [];
  for (const unit of contract.scoring_basis.units) {
    const slot = unit.slot_refs[0] != null ? slotById.get(unit.slot_refs[0]) : undefined;
    const criterion = unit.criterion;
    if (criterion.kind === 'blank_key') {
      references.push(
        criterion.key.kind === 'text'
          ? criterion.key.accepted.join(' / ')
          : String(criterion.key.expected),
      );
    } else if (criterion.kind === 'text_key') {
      references.push(criterion.accepted_texts.join(' / '));
    } else if (criterion.kind === 'numeric_key') {
      references.push(String(criterion.expected));
    } else if (criterion.kind === 'select_key' && slot?.kind === 'select') {
      const labels = criterion.accepted_item_ids
        .map((id) => slot.items.findIndex((item) => item.item_id === id))
        .filter((index) => index >= 0)
        .map((index) => String.fromCharCode(65 + index));
      if (labels.length > 0) references.push(labels.join(''));
    } else if (
      criterion.kind === 'option_set_key' &&
      (slot?.kind === 'single_choice' || slot?.kind === 'multi_choice')
    ) {
      const labels = criterion.accepted_option_ids
        .map((id) => slot.options.find((option) => option.option_id === id)?.label)
        .filter((label): label is string => label != null && label.length > 0);
      if (labels.length > 0) references.push(labels.join(''));
    }
  }
  const referenceMd = references.length > 0 ? references.join('\n\n') : null;
  const choiceSlot = contract.response_spec.slots.find(
    (slot) =>
      slot.kind === 'select' || slot.kind === 'single_choice' || slot.kind === 'multi_choice',
  );
  const choicesMd =
    choiceSlot?.kind === 'select'
      ? choiceSlot.items.map((item) => item.label_md ?? item.item_id)
      : choiceSlot?.kind === 'single_choice' || choiceSlot?.kind === 'multi_choice'
        ? choiceSlot.options.map((option) => option.text)
        : null;
  const slotKinds = new Set(contract.response_spec.slots.map((slot) => slot.kind));
  const composite = parts.length > 1 || slotKinds.size > 1;
  const choice =
    slotKinds.has('select') || slotKinds.has('single_choice') || slotKinds.has('multi_choice');
  const blank =
    slotKinds.has('blank') ||
    slotKinds.has('text') ||
    slotKinds.has('numeric') ||
    slotKinds.has('formula');
  const kind = composite ? 'composite' : choice ? 'choice' : blank ? 'fill_blank' : 'short_answer';
  return {
    prompt_md: promptMd,
    reference_md: referenceMd,
    choices_md: choicesMd,
    kind,
    canonical_content_hash: canonicalQuestionContentHash({
      promptMd,
      referenceMd,
      choicesMd,
      ...(composite ? { composite: true } : {}),
    }),
    draft_status: LEGACY_DRAFT_STATUS.ACTIVE,
  };
}

async function subjectProfileFor(db: Db | Tx, rootId: string) {
  const [row] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, rootId))
    .limit(1);
  const first = row?.knowledge_ids?.[0];
  const [node] = first
    ? await db
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, first))
        .limit(1)
    : [undefined];
  return resolveSubjectProfile(node?.domain ?? null);
}

export async function runAdmissionForQuestion(
  db: Db,
  suppliedData: QuestionAdmissionRunData,
  delivery: AdmissionDelivery = { id: randomUUID() },
  deps: { runTask?: PracticeTaskRunFn } = {},
): Promise<QuestionAdmissionRunResult> {
  const data = AdmissionJobData.parse(suppliedData);
  let groupId = data.question_id;
  if (!groupId && data.revision_id) {
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, data.revision_id));
    groupId = revision?.group_id;
  }
  if (!groupId)
    throw new ApiError(
      'bad_request',
      'question_admission_run requires question_id or revision_id',
      400,
    );
  const [supplied] = await db.select().from(question).where(eq(question.id, groupId));
  const rootId = supplied?.parent_question_id ?? groupId;
  const simple = (status: QuestionAdmissionRunResult['status']): QuestionAdmissionRunResult => ({
    status,
    group_id: rootId,
    per_unit: [],
  });
  await settleExpiredPaidEffectSends(db, { family: ADMISSION_FAMILY });

  const batch = await db.transaction(async (tx) => {
    // Same family -> delivery -> root -> lifecycle -> effect lock order on every entry.
    await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
    await assertAdmissionDelivery(tx, delivery);
    const { root, lifecycle } = await lockAdmissionGroup(tx, rootId);
    if (!root) throw new ApiError('not_found', `question '${rootId}' not found`, 404);
    const graded = await loadGradedContract(tx, rootId, lifecycle?.current_revision_id ?? null);
    const { contract, revision } = graded;
    const [terminal] = await tx
      .select({ id: question_admission_verification.id })
      .from(question_admission_verification)
      .innerJoin(
        question_revision,
        eq(question_admission_verification.revision_id, question_revision.revision_id),
      )
      .where(
        and(
          eq(question_revision.group_id, rootId),
          inArray(question_admission_verification.policy_id, [
            ...QUESTION_ADMISSION_POLICY_IDS,
            resolveQuestionAdmissionPolicyId(),
          ]),
          sql`${question_admission_verification.evidence}->>'pack' = 'question_admission'`,
          sql`${question_admission_verification.evidence}->>'base_contract_digest' = ${contract.integrity_digest}`,
          inArray(question_admission_verification.outcome, ['passed', 'failed', 'suspended']),
        ),
      )
      .limit(1);
    const pinned =
      graded.digestMatches &&
      (!data.revision_id || revision?.revision_id === data.revision_id) &&
      (!data.expected_revision_digest ||
        revision?.integrity_digest === data.expected_revision_digest) &&
      (data.expected_admission_generation === undefined ||
        lifecycle?.scoring_admission_generation === data.expected_admission_generation);
    // Only pending admission publications may initiate automatic spend. Explicit
    // direct draft invocation remains available, but never overrides lifecycle holds.
    const eligible = lifecycle ? isPendingAdmission(lifecycle) : data.revision_id === undefined;
    const input = FrozenAdmissionInput.parse(
      JSON.parse(
        JSON.stringify({
          version: 1,
          group_id: rootId,
          revision_id: revision?.revision_id ?? null,
          revision_digest: revision?.integrity_digest ?? null,
          admission_generation: lifecycle?.scoring_admission_generation ?? 0,
          contract,
          subject_profile: await subjectProfileFor(tx, rootId),
          policy_id: resolveQuestionAdmissionPolicyId(),
          solver2:
            SOLVER2_PROVIDER || SOLVER2_MODEL
              ? { provider: SOLVER2_PROVIDER, model: SOLVER2_MODEL }
              : null,
        }),
      ),
    );
    // YUK-1568（R1 P1-1 纵深防御）：声明 answer_shape 的题没有已准入的数学
    // 比较器（第 2 片）—— claim/付费发送之前强制关闸，覆盖 enqueue 之外的
    // manual re-dispatch 与 direct invocation。既有 receipt 的应用与审计
    //（claim 内 receipt/historical 分支在 maySend 判断之前）不受影响；被拦
    // 的 claim 以 stale 结束，不产生 paid 行、不重置 authorization。
    const declaredUnsupported = findAnswerShapeDeclarations(contract.response_spec).length > 0;
    return claimAdmissionBatch(tx, input, delivery, {
      maySend: pinned && eligible && !declaredUnsupported,
      historicalTerminal: Boolean(terminal),
    });
  });
  if (batch.kind === 'applied') return simple(batch.status);
  if (batch.kind === 'historical') return simple('already_verified');
  if (batch.kind === 'stale') return simple('stale');
  if (batch.kind === 'held') return simple('pending');

  const attemptedTaskRunIds = new Set<string>();
  let receipt: AdmissionResultReceipt;
  if (batch.kind === 'receipt') {
    receipt = batch.receipt;
  } else {
    try {
      const executeTask =
        deps.runTask ??
        makePracticeTaskTextRunFn(db, {
          providerSessionDeadlineAt: Date.now() + 15 * 60_000,
          judgeRetryPolicy: 'none',
        });
      const runTask: PracticeTaskRunFn = async (...args) => {
        try {
          const result = await executeTask(...args);
          if (result.task_run_id) attemptedTaskRunIds.add(result.task_run_id);
          return result;
        } catch (error) {
          // Central runner binds the durable id even to structured terminal /
          // timeout failures. Keep it on paid_effect, not only in task logs.
          if (
            error != null &&
            typeof error === 'object' &&
            'taskRunId' in error &&
            typeof error.taskRunId === 'string'
          )
            attemptedTaskRunIds.add(error.taskRunId);
          throw error;
        }
      };
      const result = await runQuestionAdmission(definitionFromContract(batch.input.contract), {
        db,
        runTask,
        subjectProfile: batch.input.subject_profile,
        solver2: batch.input.solver2
          ? {
              ...(batch.input.solver2.provider
                ? { provider: batch.input.solver2.provider as Provider }
                : {}),
              ...(batch.input.solver2.model ? { model: batch.input.solver2.model } : {}),
            }
          : null,
        policyId: batch.input.policy_id,
      });
      if (result.status === 'pending') {
        await db.transaction((tx) =>
          markPaidEffectUnknown(
            tx,
            batch.identity,
            delivery.id,
            `admission_pending:${result.reason ?? 'unsealed_result'};task_runs=${[...new Set([...attemptedTaskRunIds, ...result.evidence_refs.task_run_ids])].join(',')}`,
            { fence: batch.fence },
          ),
        );
        return { ...simple('pending'), per_unit: result.per_unit };
      }
      receipt = AdmissionResultReceipt.parse(
        JSON.parse(JSON.stringify({ version: 1, recorded_at: new Date().toISOString(), result })),
      );
      // Separate durable transaction: a publication failure must not lose the paid result.
      await db.transaction((tx) =>
        recordPaidEffectResult(tx, batch.identity, delivery.id, receipt, { fence: batch.fence }),
      );
    } catch (error) {
      await db.transaction(async (tx) => {
        await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
        const snapshot = await readPaidEffect(tx, batch.identity);
        if (snapshot?.state === 'sending' || snapshot?.state === 'unknown') {
          await markPaidEffectUnknown(
            tx,
            batch.identity,
            delivery.id,
            `${error instanceof Error ? error.message : String(error)};task_runs=${[...attemptedTaskRunIds].join(',')}`,
            { fence: batch.fence },
          );
        }
      });
      throw error;
    }
  }

  try {
    return await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
      const control = await admitPaidEffectDeliveryControl(tx, ADMISSION_FAMILY, {
        backend: 'pg-boss',
        deliveryId: delivery.id,
        generation: delivery.jobData?.dispatch_generation ?? 0,
      });
      if (control.kind === 'fenced')
        throw new Error('Question admission application backend/generation fenced');
      const snapshot = await readPaidEffect(tx, batch.identity);
      if (snapshot?.state === 'applied')
        return simple(completedAdmissionStatus(snapshot.application));
      const { root, lifecycle } = await lockAdmissionGroup(tx, rootId);
      const fresh = root
        ? await loadGradedContract(tx, rootId, lifecycle?.current_revision_id ?? null)
        : null;
      const freshDigest = fresh?.digestMatches ? fresh.contract.integrity_digest : null;
      const current =
        root != null &&
        freshDigest != null &&
        freshDigest === batch.input.contract.integrity_digest &&
        (lifecycle?.current_revision_id ?? null) === batch.input.revision_id;
      if (!current) {
        await recordPaidEffectApplication(tx, batch.identity, {
          status: 'stale',
          group_id: rootId,
        });
        return simple('stale');
      }
      if (lifecycle && !isPendingAdmission(lifecycle)) {
        // A hold/retraction/other admission decision blocks application, not the
        // immutable paid result. Re-pending can replay it under the new generation.
        await notePaidEffectApplicationFailure(
          tx,
          batch.identity,
          'receipt_waits_for_pending_admission',
        );
        return simple('pending');
      }
      const result = receipt.result;
      if (result.status === 'pending')
        throw new Error('Unknown admission result cannot be applied');
      const decision = await runQuestionAdmissionChecks(tx, {
        knowledgeIds: root.knowledge_ids ?? [],
        unitSummary: result.per_unit.map((unit) => ({
          unit_id: unit.scoring_unit_id,
          judgeable_today: unit.status !== 'withheld',
          ...(unit.reason != null ? { withheld_reason: unit.reason } : {}),
        })),
        verdict: {
          status: result.status,
          per_unit: result.per_unit.map((unit) => ({
            scoring_unit_id: unit.scoring_unit_id,
            status: unit.status,
            ...(unit.reason != null ? { reason: unit.reason } : {}),
          })),
        },
      });
      if (decision.group_blockers.length > 0) {
        await notePaidEffectApplicationFailure(
          tx,
          batch.identity,
          decision.group_blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join('; '),
        );
        return simple('pending');
      }
      const admitted = decision.admission.state === 'admitted' && result.resolved !== undefined;
      const now = new Date(receipt.recorded_at);
      const verifierContext = batch.input.solver2
        ? 'independent_model'
        : 'same_model_isolated_context';
      // The model key is comparison evidence. Publish the sealed revision so an
      // unchanged author key does not mint another revision.
      const contract = batch.input.contract;
      const persisted = await publishQuestionGroup(tx, {
        group_id: rootId,
        contract,
        expectedCurrentRevision: batch.input.revision_id,
        expectedAdmissionGeneration: lifecycle?.scoring_admission_generation ?? null,
        availability:
          lifecycle?.availability ??
          (root.source === 'web_sourced' || root.source === 'quiz_gen'
            ? 'general_pool'
            : 'container_only'),
        admission: admitted
          ? {
              state: 'admitted',
              evidence: {
                marking_provenance: 'system_verified',
                verification: {
                  structural_check_passed: true,
                  independent_verification: {
                    passed: true,
                    verifier: 'independent_model',
                    verified_at: receipt.recorded_at,
                  },
                  note: `YUK-1445 dual blind solve + frozen probe calibration (${batch.input.policy_id}); verifier_context=${verifierContext}`,
                },
                model_slice: null,
              },
            }
          : {
              state: 'withheld',
              reason: result.per_unit.some((u) => u.reason === 'no_admitted_executor')
                ? 'no_admitted_executor'
                : result.per_unit.some((u) => u.reason?.startsWith('source_crosscheck'))
                  ? 'verification_failed'
                  : 'unverified_rules',
            },
        ...(admitted ? { suspension: { suspended: false } } : {}),
        verification: result.verification,
        actorRef: 'practice:question_admission',
        publishedBy: {
          by: 'system',
          lane: 'question_admission',
          policy_id: batch.input.policy_id,
          task_run_ids: result.evidence_refs.task_run_ids,
        },
        now,
      });
      const status =
        persisted.status === 'conflict' ? 'conflict' : admitted ? 'admitted' : 'withheld';
      if (status === 'admitted') {
        const projected = projectAdmittedQuestionRow(contract);
        await tx
          .update(question)
          .set({
            prompt_md: projected.prompt_md,
            reference_md: projected.reference_md,
            choices_md: projected.choices_md,
            kind: projected.kind,
            canonical_content_hash: projected.canonical_content_hash,
            draft_status: projected.draft_status,
            updated_at: now,
            version: sql`${question.version} + 1`,
          })
          .where(eq(question.id, rootId));
      }
      const application: QuestionAdmissionRunResult = {
        status,
        group_id: rootId,
        per_unit: result.per_unit,
        ...('current_revision_id' in persisted && persisted.current_revision_id != null
          ? { revision_id: persisted.current_revision_id }
          : {}),
        ...('revision_id' in persisted ? { revision_id: persisted.revision_id } : {}),
        ...('revision_ordinal' in persisted
          ? { revision_ordinal: persisted.revision_ordinal }
          : {}),
      };
      await recordPaidEffectApplication(tx, batch.identity, application);
      return application;
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
      if ((await readPaidEffect(tx, batch.identity))?.state === 'receipt_ready') {
        await notePaidEffectApplicationFailure(
          tx,
          batch.identity,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    throw error;
  }
}

export function buildQuestionAdmissionRunHandler(
  db: Db,
): (jobs: Job<QuestionAdmissionRunData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const result = await runAdmissionForQuestion(db, job.data, { id: job.id, jobData: job.data });
      console.log(
        `[question_admission_run] ${result.group_id} -> ${result.status}` +
          (result.revision_id ? ` rev=${result.revision_id}` : ''),
      );
    }
  };
}
