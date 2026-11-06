// one durable admission batch per group/base digest.
// The publisher event outbox enqueues pinned revisions. Queue retries replay a
// complete result receipt, never paid solves. Unknown payments stay fenced after question closure.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { AgentRunError } from '@/ai/agent-run-error';
import { canonicalProviderName } from '@/ai/task-spec';
import { QUESTION_ADMISSION_POLICY_IDS } from '@/core/question-admission-policy';
import { declaredShapesAllSupported } from '@/core/schema/assessment/blank-answer-compare';
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
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import {
  event,
  knowledge,
  paid_effect,
  question,
  question_admission_verification,
  question_revision,
  question_solution_prior,
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
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { type BoundRunTaskTextFn, makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { getStartedBoss } from '@/server/boss/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  placementAuthority as placementAuthorityPort,
  readVisibleVectorNearHold,
} from '../../supply/public';
import { ADJUDICATION_TASK_KIND } from '../server/admission/adjudicate';
import { runQuestionAdmissionChecks } from '../server/admission/checks';
import {
  ADMISSION_FAMILY,
  AdmissionJobData,
  admissionJobId,
  admissionTranscriptAllowed,
  isPendingAdmission,
  lockAdmissionGroup,
  readAdmissionPurpose,
} from '../server/admission/enqueue';
import { type Provider, definitionFromContract } from '../server/admission/index';
import {
  enqueueAdmissionLoginRecovery,
  maintainAdmissionLoginRecovery,
} from '../server/admission/login-recovery';
import {
  type AdmissionDelivery,
  AdmissionResultReceipt,
  FrozenAdmissionInput,
  assertAdmissionDelivery,
  claimAdmissionBatch,
  completedAdmissionStatus,
} from '../server/admission/receipt';
import {
  admissionCheckVerdict,
  buildAdmissionPublishInput,
  projectAdmittedQuestionRow,
} from '../server/admission/resolved-publication';
import {
  resolveQuestionAdmissionPolicyId,
  runQuestionAdmission,
} from '../server/admission/run-admission';
import {
  SolutionPriorRecord,
  loadPriorKnowledgeCandidates,
  recordAdmissionSolutionPrior,
} from '../server/admission/solution-prior';
import { QUESTION_ADMISSION_TASK_KIND } from '../server/admission/solve';
import {
  ADMISSION_STAGE_FAMILY,
  AdmissionInterrupted,
  AdmissionNotSent,
  type AdmissionRecoveryReader,
  type AdmissionStageReceiptRef,
  AdmissionWaiting,
  admissionStageRunner,
} from '../server/admission/stages';
import { demoteWaitingCoordinatorOnUnresolvedStage } from '../server/admission/unknown-closure';
import {
  applyCustomPreviewDecision,
  prepareAdmissionCustomPreview,
} from '../server/custom-block-preview/admission-preview';

export type QuestionAdmissionRunData = AdmissionJobData;
export interface QuestionAdmissionRunResult {
  status:
    | 'admitted'
    | 'withheld'
    | 'pending'
    | 'waiting'
    | 'stale'
    | 'conflict'
    | 'already_verified';
  group_id: string;
  revision_id?: string;
  revision_ordinal?: number;
  per_unit: { scoring_unit_id: string; status: string; reason?: string }[];
}
const SOLVER2_PROVIDER_RAW = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
const SOLVER2_PROVIDER = SOLVER2_PROVIDER_RAW
  ? (canonicalProviderName(SOLVER2_PROVIDER_RAW) as Provider)
  : undefined;
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

function admissionInputIsCurrent(
  graded: GradedContract | null,
  currentRevisionId: string | null,
  input: FrozenAdmissionInput,
) {
  return (
    graded?.digestMatches === true &&
    graded.contract.integrity_digest === input.contract.integrity_digest &&
    currentRevisionId === input.revision_id
  );
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
  deps: {
    runTask?: BoundRunTaskTextFn;
    signal?: AbortSignal;
    providerRecovery?: AdmissionRecoveryReader;
  } = {},
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
  await settleExpiredPaidEffectSends(db, { family: ADMISSION_STAGE_FAMILY });
  // A question bound to a live sourcing_web placement delivery is admitted under that claim:
  // the delivery's authority must hold before this paid batch is claimed (the batch is one
  // paid effect), each solve call is recorded on the claim, and the application re-checks the
  // current binding. A stale binding stops here, before any paid send is claimed.
  const placementAuthority = await placementAuthorityPort.readPlacementQuestionAuthority(
    db,
    rootId,
  );
  if (placementAuthority) {
    await placementAuthorityPort.assertPlacementPaidEffectAuthority(db, {
      scope: 'question',
      authority: placementAuthority,
    });
  }

  const batch = await db.transaction(async (tx) => {
    // Same family -> delivery -> root -> lifecycle -> effect lock order on every entry.
    await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
    await assertAdmissionDelivery(tx, delivery);
    const { root, lifecycle } = await lockAdmissionGroup(tx, rootId);
    if (!root) throw new ApiError('not_found', `question '${rootId}' not found`, 404);
    if (
      (!lifecycle || isPendingAdmission(lifecycle)) &&
      (await readVisibleVectorNearHold(tx, root.metadata ?? {}))
    ) {
      return { kind: 'vector_held' as const };
    }
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
          // bind the terminal verdict to the CURRENT content through
          // the publisher-written revision_digest column (authoritative after
          // resolved-contract publication: the receipt's base_contract_digest
          // stays the paid INPUT digest), falling back to the legacy evidence
          // field for rows where base content == published document.
          or(
            eq(question_admission_verification.revision_digest, contract.integrity_digest),
            sql`${question_admission_verification.evidence}->>'base_contract_digest' = ${contract.integrity_digest}`,
          ),
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
    // 声明 answer_shape 的题由共享比较核心判定支持后
    // 才可发起付费 claim —— 未实现 notation、未知/坏声明在 claim/付费发送
    // 之前强制关闸，覆盖 enqueue 之外的 manual re-dispatch 与 direct
    // invocation。既有 receipt 的应用与审计（claim 内 receipt/historical 分
    // 支在 maySend 判断之前）不受影响；被拦的 claim 以 stale 结束，不产生
    // paid 行、不重置 authorization。
    const declaredUnsupported = !declaredShapesAllSupported(contract.response_spec).ok;
    const purpose = delivery.jobData
      ? await readAdmissionPurpose(tx, delivery.id, input, delivery.jobData)
      : { state: 'unknown' as const, sourceId: null };
    const claimed = await claimAdmissionBatch(tx, input, delivery, {
      maySend: pinned && eligible && !declaredUnsupported && purpose.state === 'allow',
      historicalTerminal: Boolean(terminal),
    });
    // A reused paid receipt belongs to its ORIGINAL delivery, not to the new
    // publication that happened to reach this batch. Never retag its provenance.
    const originalDelivery =
      claimed.kind === 'receipt' || claimed.kind === 'winner'
        ? ((await readPaidEffect(tx, claimed.identity))?.delivery.deliveryId ?? null)
        : null;
    const originalPurpose = originalDelivery
      ? await readAdmissionPurpose(
          tx,
          originalDelivery,
          claimed.input,
          originalDelivery === delivery.id ? delivery.jobData : undefined,
        )
      : purpose;
    if (
      claimed.kind === 'receipt' &&
      claimed.receipt.result.status === 'waiting' &&
      !admissionInputIsCurrent(graded, lifecycle?.current_revision_id ?? null, claimed.input)
    ) {
      await recordPaidEffectApplication(tx, claimed.identity, {
        status: 'stale',
        group_id: rootId,
      });
      return {
        ...claimed,
        kind: 'applied' as const,
        status: 'stale' as const,
        purpose: originalPurpose,
        sourceDeliveryId: originalDelivery,
        staleInput: true,
      };
    }
    return {
      ...claimed,
      purpose: originalPurpose,
      sourceDeliveryId: originalDelivery,
      staleInput: !pinned || !eligible || declaredUnsupported,
    };
  });
  if (batch.kind === 'vector_held') return simple('withheld');
  if (batch.kind === 'applied') return simple(batch.status);
  if (batch.kind === 'historical') return simple('already_verified');
  if (batch.kind === 'stale')
    return batch.staleInput || batch.purpose.state === 'allow'
      ? simple('stale')
      : {
          ...simple('withheld'),
          per_unit: batch.input.contract.scoring_basis.units.map((unit) => ({
            scoring_unit_id: unit.scoring_unit_id,
            status: 'withheld',
            reason: `source_purpose_${batch.purpose.state}`,
          })),
        };
  if (batch.kind === 'held') return simple(batch.staleInput ? 'withheld' : 'pending');

  const checkPurpose = async (tx: Tx) =>
    batch.sourceDeliveryId
      ? readAdmissionPurpose(tx, batch.sourceDeliveryId, batch.input)
      : { state: 'unknown' as const, sourceId: null };

  const attemptedTaskRunIds = new Set<string>();
  let receipt: AdmissionResultReceipt;
  if (batch.kind === 'receipt' && batch.receipt.result.status !== 'waiting') {
    receipt = batch.receipt;
  } else {
    const batchFence =
      batch.kind === 'winner' ? batch.fence : (await readPaidEffect(db, batch.identity))?.fence;
    if (batchFence == null) throw new Error('Admission coordinator fence missing');
    const controller = new AbortController();
    const abort = () => controller.abort(deps.signal?.reason);
    if (deps.signal?.aborted) abort();
    else deps.signal?.addEventListener('abort', abort, { once: true });
    const stageReceiptRefs: AdmissionStageReceiptRef[] = [];
    let purposeStopped = false;
    let superseded = false;
    let checking = false;
    const beforeSend = async () => {
      controller.signal.throwIfAborted();
      try {
        await db.transaction(async (tx) => {
          await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
          await assertAdmissionDelivery(tx, delivery);
          const { root, lifecycle } = await lockAdmissionGroup(tx, rootId);
          const current = root
            ? await loadGradedContract(tx, rootId, lifecycle?.current_revision_id ?? null)
            : null;
          if (
            !admissionInputIsCurrent(current, lifecycle?.current_revision_id ?? null, batch.input)
          ) {
            superseded = true;
            throw new Error('Question admission input revision was superseded');
          }
          if (lifecycle && !isPendingAdmission(lifecycle)) {
            superseded = true;
            throw new Error('Question admission lifecycle no longer permits a paid send');
          }
          const snapshot = await readPaidEffect(tx, batch.identity);
          if (
            !(
              snapshot?.state === 'sending' ||
              (snapshot?.state === 'receipt_ready' &&
                AdmissionResultReceipt.parse(snapshot.result).result.status === 'waiting')
            ) ||
            snapshot.fence !== batchFence ||
            snapshot.delivery.deliveryId !== batch.sourceDeliveryId
          )
            throw new Error('Question admission original paid send fence closed');
          const purpose = await checkPurpose(tx);
          if (purpose.state !== 'allow')
            throw new Error(`Question admission original source purpose ${purpose.state}`);
        });
        controller.signal.throwIfAborted();
      } catch (error) {
        if (!controller.signal.aborted) {
          purposeStopped = true;
          controller.abort(error);
        }
        throw error;
      }
    };
    // The durable source/paid fences survive worker loss. This timer merely
    // cooperates with an already issued transport; it cannot prove withdrawal.
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void beforeSend()
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, 1000);
    timer.unref();
    const recordPlacementAdmissionCall = async (runId: string | null, costUsd: number | null) => {
      if (!placementAuthority) return;
      await placementAuthorityPort.recordPlacementPaidEffect(db, {
        authority: { scope: 'question', authority: placementAuthority },
        kind: 'question_admission',
        invocationKey: `${placementAuthority.attempt_id}:${rootId}:question_admission:${randomUUID()}`,
        providerTaskRunId: runId,
        costUsd,
      });
    };
    try {
      const providerSessionDeadlineAt = Date.now() + 15 * 60_000;
      const executeTask =
        deps.runTask ??
        makeRunTaskTextFn(db, {
          providerSessionDeadlineAt,
          judgeRetryPolicy: 'none',
          laminarTranscript: await admissionTranscriptAllowed(db, {
            groupId: rootId,
            purposeState: batch.purpose.state,
          }),
        });
      const fencedTask: BoundRunTaskTextFn = async (...args) => {
        let queryStarted = false;
        try {
          await beforeSend();
          const [kind, input, ctx] = args;
          if (kind !== QUESTION_ADMISSION_TASK_KIND && kind !== ADJUDICATION_TASK_KIND)
            throw new Error('Question admission task kind differs from its frozen solve contract');
          const taskCtx = {
            ...ctx,
            lifecycleAbortController: controller,
            beforeProviderQuery: async (started) => {
              await beforeSend();
              await ctx?.beforeProviderQuery?.(started);
              queryStarted = true;
            },
          } satisfies import('@/server/ai/runner-fn').RunTaskCallCtx;
          const result =
            kind === QUESTION_ADMISSION_TASK_KIND
              ? await executeTask(QUESTION_ADMISSION_TASK_KIND, input, taskCtx)
              : await executeTask('QuestionAdmissionAdjudicateTask', input, taskCtx);
          if (result.task_run_id) attemptedTaskRunIds.add(result.task_run_id);
          await recordPlacementAdmissionCall(result.task_run_id ?? null, result.cost_usd ?? null);
          return result;
        } catch (error) {
          // Central runner binds the durable id even to structured terminal /
          // timeout failures. Keep it on paid_effect, not only in task logs.
          const failedRunId =
            error != null &&
            typeof error === 'object' &&
            'taskRunId' in error &&
            typeof error.taskRunId === 'string'
              ? error.taskRunId
              : null;
          if (failedRunId) attemptedTaskRunIds.add(failedRunId);
          if (!purposeStopped && queryStarted && failedRunId)
            await recordPlacementAdmissionCall(
              failedRunId,
              error instanceof AgentRunError ? (error.costUsd ?? null) : null,
            );
          throw error;
        }
      };
      const runTask = admissionStageRunner({
        db,
        groupId: rootId,
        baseDigest: batch.input.contract.integrity_digest,
        deliveryId: delivery.id,
        execute: fencedTask,
        taskRunIds: attemptedTaskRunIds,
        receiptRefs: stageReceiptRefs,
        beforeSend,
        interrupted: () => purposeStopped || controller.signal.aborted,
        interruptionReason: () => controller.signal.reason,
        recovery: deps.providerRecovery,
        recoveryConfirmed: data.recovery_confirmed,
        loginProbeRoute: data.login_probe_route,
        signal: controller.signal,
        deadlineAt: providerSessionDeadlineAt,
      });
      // Metadata for the solution prior only: a read failure must not touch the paid batch.
      const knowledgeCandidates = await loadPriorKnowledgeCandidates(db, {
        groupId: rootId,
        subjectId: batch.input.subject_profile.id,
      }).catch((error: unknown) => {
        console.warn('[question_admission] prior knowledge candidates unavailable', {
          group_id: rootId,
          err: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      const priorRows = batch.input.revision_id
        ? await db
            .select({ part_id: question_solution_prior.part_id })
            .from(question_solution_prior)
            .where(eq(question_solution_prior.revision_id, batch.input.revision_id))
        : [];
      const priorComplete = batch.input.contract.structure.parts.every((part) =>
        priorRows.some((row) => row.part_id === part.part_id),
      );
      const result = await runQuestionAdmission(definitionFromContract(batch.input.contract), {
        db,
        runTask,
        ...(priorComplete && batch.input.revision_digest
          ? { priorRevisionDigest: batch.input.revision_digest }
          : {}),
        knowledgeCandidates,
        subjectProfile: batch.input.subject_profile,
        solver2: batch.input.solver2
          ? {
              ...(batch.input.solver2.provider
                ? { provider: canonicalProviderName(batch.input.solver2.provider) as Provider }
                : {}),
              ...(batch.input.solver2.model ? { model: batch.input.solver2.model } : {}),
            }
          : null,
        policyId: batch.input.policy_id,
      });
      await beforeSend();
      if (result.status === 'withheld') {
        const [source] = batch.purpose.sourceId
          ? await db
              .select({ action: event.action })
              .from(event)
              .where(eq(event.id, batch.purpose.sourceId))
          : [];
        result.verification.evidence.repair_delivery =
          source?.action === 'experimental:question_draft_submit'
            ? { kind: 'author_repair', source_event_id: batch.purpose.sourceId }
            : {
                kind: 'system_closed',
                reason: 'no_author',
                source_event_id: batch.purpose.sourceId,
              };
      }
      result.evidence_refs.task_run_ids = [
        ...new Set([...attemptedTaskRunIds, ...result.evidence_refs.task_run_ids]),
      ];
      result.verification.evidence.attempt_run_ids = result.evidence_refs.task_run_ids;
      result.verification.evidence.paid_stage_receipts = stageReceiptRefs;
      receipt = AdmissionResultReceipt.parse(
        JSON.parse(JSON.stringify({ version: 1, recorded_at: new Date().toISOString(), result })),
      );
      // Separate durable transaction: a publication failure must not lose the paid result.
      if (batch.kind === 'winner')
        await db.transaction((tx) =>
          recordPaidEffectResult(tx, batch.identity, delivery.id, receipt, { fence: batchFence }),
        );
    } catch (error) {
      if (superseded && !deps.signal?.aborted) {
        const stale = await db.transaction(async (tx) => {
          await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
          const snapshot = await readPaidEffect(tx, batch.identity);
          if (snapshot?.state === 'sending' && batch.kind === 'winner') {
            const [unresolved] = await tx
              .select({ unit: paid_effect.unit })
              .from(paid_effect)
              .where(
                and(
                  eq(paid_effect.family, ADMISSION_STAGE_FAMILY),
                  eq(paid_effect.entity_id, rootId),
                  eq(paid_effect.entity_revision, batch.identity.entityRevision),
                  inArray(paid_effect.state, ['sending', 'unknown']),
                ),
              )
              .limit(1);
            if (unresolved) return false;
            await recordPaidEffectResult(
              tx,
              batch.identity,
              delivery.id,
              AdmissionResultReceipt.parse({
                version: 1,
                recorded_at: new Date().toISOString(),
                result: {
                  status: 'withheld',
                  reason: 'stale_input',
                  per_unit: [],
                  verification: {
                    policy_id: batch.input.policy_id,
                    outcome: 'suspended',
                    evidence: {
                      pack: 'question_admission_stale',
                      paid_stage_receipts: stageReceiptRefs,
                    },
                  },
                  evidence_refs: { task_run_ids: [...attemptedTaskRunIds] },
                },
              }),
              { fence: batchFence },
            );
          } else if (snapshot?.state !== 'receipt_ready') return false;
          await recordPaidEffectApplication(tx, batch.identity, {
            status: 'stale',
            group_id: rootId,
          });
          return true;
        });
        if (stale) return simple('stale');
      }
      const interrupted =
        purposeStopped || controller.signal.aborted || error instanceof AdmissionInterrupted;
      if (error instanceof AdmissionWaiting && !interrupted) {
        const waitingReceipt = AdmissionResultReceipt.parse({
          version: 1,
          recorded_at: new Date().toISOString(),
          result: {
            status: 'waiting',
            waiting: { ...error.recovery, stage: error.stage },
            per_unit: [],
            verification: {
              policy_id: batch.input.policy_id,
              outcome: 'suspended',
              evidence: {
                pack: 'question_admission_wait',
                waiting: error.recovery,
                stage: error.stage,
                task_run_ids: [...attemptedTaskRunIds],
                paid_stage_receipts: stageReceiptRefs,
              },
            },
            evidence_refs: { task_run_ids: [...attemptedTaskRunIds] },
          },
        });
        const boss =
          (error.recovery.reason === 'quota' && error.recovery.retry_at) ||
          (error.recovery.reason === 'login' && error.route)
            ? await getStartedBoss()
            : null;
        await db.transaction(async (tx) => {
          await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
          await assertAdmissionDelivery(tx, delivery);
          if (batch.kind === 'winner')
            await recordPaidEffectResult(tx, batch.identity, delivery.id, waitingReceipt, {
              fence: batchFence,
            });
          if (boss && error.recovery.reason === 'quota' && error.recovery.retry_at) {
            const wakeData = {
              ...data,
              admission_version: 4 as const,
              question_id: rootId,
              recovery_confirmed: false,
            };
            await boss.send(ADMISSION_FAMILY, wakeData, {
              id: admissionJobId(
                rootId,
                batch.input.revision_id ?? rootId,
                `${batch.input.contract.integrity_digest}:${error.stage}`,
                batch.input.admission_generation,
              ),
              startAfter: new Date(error.recovery.retry_at),
              db: fromPgBossDrizzleTx(tx),
            });
          }
          if (boss && error.recovery.reason === 'login' && error.route)
            await enqueueAdmissionLoginRecovery(tx, boss, error.route, delivery.id);
        });
        return {
          ...simple('waiting'),
          per_unit: batch.input.contract.scoring_basis.units.map((unit) => ({
            scoring_unit_id: unit.scoring_unit_id,
            status: 'waiting',
            reason: error.recovery.reason,
          })),
        };
      }
      if (error instanceof AdmissionNotSent && !interrupted) {
        receipt = AdmissionResultReceipt.parse({
          version: 1,
          recorded_at: new Date().toISOString(),
          result: {
            status: 'withheld',
            reason: 'admission_provider_query_not_started',
            per_unit: batch.input.contract.scoring_basis.units.map((unit) => ({
              scoring_unit_id: unit.scoring_unit_id,
              status: 'withheld',
              reason: 'admission_provider_query_not_started',
            })),
            verification: {
              policy_id: batch.input.policy_id,
              outcome: 'suspended',
              evidence: {
                pack: 'question_admission_not_sent',
                repair_delivery: { kind: 'system_closed', reason: 'provider_query_not_started' },
                paid_stage_receipts: stageReceiptRefs,
              },
            },
            evidence_refs: { task_run_ids: [...attemptedTaskRunIds] },
          },
        });
        if (batch.kind === 'winner')
          await db.transaction((tx) =>
            recordPaidEffectResult(tx, batch.identity, delivery.id, receipt, { fence: batchFence }),
          );
      } else {
        await db.transaction(async (tx) => {
          await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
          const snapshot = await readPaidEffect(tx, batch.identity);
          if (snapshot?.state === 'sending' || snapshot?.state === 'unknown') {
            await markPaidEffectUnknown(
              tx,
              batch.identity,
              delivery.id,
              `${error instanceof Error ? error.message : String(error)};task_runs=${[...attemptedTaskRunIds].join(',')}`,
              { fence: batchFence },
            );
          } else if (snapshot?.state === 'receipt_ready') {
            // A recorded 'waiting' receipt answered by an unresolved stage
            // send can never be re-asked: redeliveries keep landing on the
            // same stage row, and no wakeup is scheduled.
            await demoteWaitingCoordinatorOnUnresolvedStage(tx, batch.identity, {
              expectedFence: snapshot.fence,
              result: snapshot.result,
            });
          }
        });
        deps.signal?.throwIfAborted();
        if (interrupted) return simple('pending');
        throw error;
      }
    } finally {
      clearInterval(timer);
      deps.signal?.removeEventListener('abort', abort);
    }
  }

  try {
    const purpose = await db.transaction(checkPurpose);
    if (purpose.state !== 'allow') {
      await db.transaction((tx) =>
        notePaidEffectApplicationFailure(
          tx,
          batch.identity,
          `receipt_waits_for_original_source_purpose:${purpose.state}`,
        ),
      );
      return simple('pending');
    }
    // The paid result is already durable. Browser/resource work never runs under
    // a paid-effect, business or publication lock; receipt-ready replay is free.
    const preview = await prepareAdmissionCustomPreview(
      db,
      batch.input,
      receipt,
      {
        total_ms: 15_000,
        ready_ms: 3_000,
        focus_observation_ms: 3_000,
        memory_bytes: 512 * 1024 * 1024,
      },
      deps.signal,
    );
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
      // Placement rows before group rows, the same order as the verifier writebacks.
      const currentPlacement = await placementAuthorityPort.readPlacementQuestionAuthority(
        tx,
        rootId,
      );
      if (currentPlacement)
        await placementAuthorityPort.assertPlacementAuthority(tx, currentPlacement);
      const { root, lifecycle } = await lockAdmissionGroup(tx, rootId);
      const purpose = await checkPurpose(tx);
      if (purpose.state !== 'allow') {
        await notePaidEffectApplicationFailure(
          tx,
          batch.identity,
          `receipt_waits_for_original_source_purpose:${purpose.state}`,
        );
        return simple('pending');
      }
      const fresh = root
        ? await loadGradedContract(tx, rootId, lifecycle?.current_revision_id ?? null)
        : null;
      const current = admissionInputIsCurrent(
        fresh,
        lifecycle?.current_revision_id ?? null,
        batch.input,
      );
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
      if (await readVisibleVectorNearHold(tx, root.metadata ?? {})) {
        await notePaidEffectApplicationFailure(tx, batch.identity, 'receipt_waits_for_vector_hold');
        return simple('withheld');
      }
      const result = receipt.result;
      if (result.status === 'pending')
        throw new Error('Unknown admission result cannot be applied');
      const decision = await runQuestionAdmissionChecks(tx, {
        knowledgeIds: root.knowledge_ids ?? [],
        ...admissionCheckVerdict(result),
      });
      if (decision.group_blockers.length > 0) {
        await notePaidEffectApplicationFailure(
          tx,
          batch.identity,
          decision.group_blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join('; '),
        );
        return simple('pending');
      }
      const gradingAdmitted =
        decision.admission.state === 'admitted' && result.resolved !== undefined;
      const now = new Date(receipt.recorded_at);
      // admitted publishes the PAID resolved contract (typed keys /
      // deterministic executors), bound to its paid_effect row through the
      // shared builder. Publishing the frozen base input admitted a still
      // human_review revision; a blocked build keeps the receipt (fail-closed)
      // instead of degrading to the base document.
      const candidate = buildAdmissionPublishInput({
        groupId: rootId,
        input: batch.input,
        identity: batch.identity,
        receipt,
        ...(batch.kind === 'receipt' && batch.receipt.result.status === 'waiting'
          ? { coordinatorReceipt: batch.receipt }
          : {}),
        admitted: gradingAdmitted,
        expectedCurrentRevision: batch.input.revision_id,
        expectedAdmissionGeneration: lifecycle?.scoring_admission_generation ?? null,
        availability:
          lifecycle?.availability ??
          (root.source === 'web_sourced' || root.source === 'quiz_gen'
            ? 'general_pool'
            : 'container_only'),
        actorRef: 'practice:question_admission',
        now,
      });
      if (candidate.kind === 'blocked') {
        await notePaidEffectApplicationFailure(tx, batch.identity, candidate.reason);
        return simple('pending');
      }
      const freshDigest = fresh?.digestMatches ? fresh.contract.integrity_digest : null;
      const built = applyCustomPreviewDecision(preview, candidate, batch.input, receipt, {
        revision_id: lifecycle?.current_revision_id ?? null,
        revision_digest: freshDigest,
        admission_generation: lifecycle?.scoring_admission_generation ?? null,
      });
      if (built.kind === 'blocked') {
        await notePaidEffectApplicationFailure(tx, batch.identity, built.reason);
        return simple('pending');
      }
      const admitted = built.admitted;
      if (preview.kind !== 'no_custom') deps.signal?.throwIfAborted();
      const persisted = await publishQuestionGroup(tx, built.publish);
      if (preview.kind !== 'no_custom') deps.signal?.throwIfAborted();
      const priorRevisionId =
        persisted.status === 'published'
          ? persisted.revision_id
          : persisted.status === 'admission_updated' || persisted.status === 'noop'
            ? persisted.current_revision_id
            : null;
      const priorRecord = SolutionPriorRecord.safeParse(
        (result as { solution_prior?: unknown }).solution_prior,
      );
      if (priorRevisionId != null && priorRecord.success) {
        // Savepoint: the prior is metadata and must never roll back the publication.
        await tx
          .transaction((sp) =>
            recordAdmissionSolutionPrior(sp, {
              revisionId: priorRevisionId,
              questionId: rootId,
              record: priorRecord.data,
              now,
            }),
          )
          .catch((error: unknown) => {
            console.warn('[question_admission] solution prior not recorded', {
              group_id: rootId,
              revision_id: priorRevisionId,
              err: error instanceof Error ? error.message : String(error),
            });
          });
      }
      const status =
        persisted.status === 'conflict' ? 'conflict' : admitted ? 'admitted' : 'withheld';
      if (status === 'admitted') {
        const projected = projectAdmittedQuestionRow(built.contract);
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
      const result = await runAdmissionForQuestion(
        db,
        job.data,
        { id: job.id, jobData: job.data },
        { signal: job.signal },
      );
      if (job.data.login_probe_route)
        await maintainAdmissionLoginRecovery(
          db,
          job.data.login_probe_route,
          job.id,
          result.status === 'pending' ? result.group_id : undefined,
        );
      if (!(result.status === 'waiting' && result.per_unit.some((unit) => unit.reason === 'login')))
        console.log(
          `[question_admission_run] ${result.group_id} -> ${result.status}` +
            (result.revision_id ? ` rev=${result.revision_id}` : ''),
        );
    }
  };
}
