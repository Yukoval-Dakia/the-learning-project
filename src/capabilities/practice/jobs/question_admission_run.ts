// one durable admission batch per group/base digest.
// The publisher event outbox enqueues pinned revisions. Queue retries replay a
// complete result receipt, never paid solves. Unknown batches require reconciliation.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
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
  admissionCheckVerdict,
  buildAdmissionPublishInput,
  projectAdmittedQuestionRow,
} from '../server/admission/resolved-publication';
import {
  resolveQuestionAdmissionPolicyId,
  runQuestionAdmission,
} from '../server/admission/run-admission';
import {
  applyCustomPreviewDecision,
  prepareAdmissionCustomPreview,
} from '../server/custom-block-preview/admission-preview';
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
  deps: { runTask?: PracticeTaskRunFn; signal?: AbortSignal } = {},
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
                ? { provider: canonicalProviderName(batch.input.solver2.provider) as Provider }
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
      console.log(
        `[question_admission_run] ${result.group_id} -> ${result.status}` +
          (result.revision_id ? ` rev=${result.revision_id}` : ''),
      );
    }
  };
}
