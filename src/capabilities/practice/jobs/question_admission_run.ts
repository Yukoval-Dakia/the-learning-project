// YUK-1507 — one durable admission batch per group/base digest.
// The publisher event outbox enqueues pinned revisions. Queue retries replay a
// complete result receipt, never paid solves. Unknown batches require reconciliation.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
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
  type PartRow,
  normalizeQuestionGroupToContract,
} from '@/kernel/records/assessment-normalization';
import { resolveSubjectProfile } from '@/subjects/profile';
import { type Provider, definitionFromContract } from '../server/admission';
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
} from '../server/admission/receipt';
import {
  QUESTION_ADMISSION_POLICY_ID,
  runQuestionAdmission,
} from '../server/admission/run-admission';
import { publishQuestionGroup } from '../server/quiz/verify-and-promote';
import { makePracticeTaskTextRunFn } from '../server/task-runtime';

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
const POLICY_ID = process.env.QUESTION_ADMISSION_POLICY_ID ?? QUESTION_ADMISSION_POLICY_ID;

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
  const contract = normalizeQuestionGroupToContract(
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
  return { contract, definition: definitionFromContract(contract) };
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
    const { contract } = await loadDefinition(tx, rootId);
    const [revision] = lifecycle?.current_revision_id
      ? await tx
          .select()
          .from(question_revision)
          .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
      : [];
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
          sql`${question_admission_verification.evidence}->>'pack' = 'question_admission'`,
          sql`${question_admission_verification.evidence}->>'base_contract_digest' = ${contract.integrity_digest}`,
          inArray(question_admission_verification.outcome, ['passed', 'failed', 'suspended']),
        ),
      )
      .limit(1);
    const pinned =
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
          policy_id: POLICY_ID,
          solver2:
            SOLVER2_PROVIDER || SOLVER2_MODEL
              ? { provider: SOLVER2_PROVIDER, model: SOLVER2_MODEL }
              : null,
        }),
      ),
    );
    return claimAdmissionBatch(tx, input, delivery, {
      maySend: pinned && eligible,
      historicalTerminal: Boolean(terminal),
    });
  });
  if (batch.kind === 'applied' || batch.kind === 'historical') return simple('already_verified');
  if (batch.kind === 'stale') return simple('stale');
  if (batch.kind === 'held') return simple('pending');

  let receipt: AdmissionResultReceipt;
  if (batch.kind === 'receipt') {
    receipt = batch.receipt;
  } else {
    try {
      const runTask = makePracticeTaskTextRunFn(db, {
        providerSessionDeadlineAt: Date.now() + 15 * 60_000,
      });
      const result = await runQuestionAdmission(definitionFromContract(batch.input.contract), {
        db,
        runTask: (kind, input, ctx) => runTask(kind, input, { ...ctx, judgeRetryPolicy: 'none' }),
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
            `admission_pending:${result.reason ?? 'unsealed_result'};task_runs=${result.evidence_refs.task_run_ids.join(',')}`,
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
            error instanceof Error ? error.message : String(error),
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
      if (snapshot?.state === 'applied') return simple('already_verified');
      const { root, lifecycle } = await lockAdmissionGroup(tx, rootId);
      const fresh = root ? await loadDefinition(tx, rootId) : null;
      const current =
        root &&
        fresh?.contract.integrity_digest === batch.input.contract.integrity_digest &&
        (lifecycle?.current_revision_id ?? null) === batch.input.revision_id &&
        (lifecycle?.scoring_admission_generation ?? 0) === batch.input.admission_generation &&
        (!lifecycle || isPendingAdmission(lifecycle));
      if (!current) {
        await recordPaidEffectApplication(tx, batch.identity, {
          status: 'stale',
          group_id: rootId,
        });
        return simple('stale');
      }
      const result = receipt.result;
      if (result.status === 'pending')
        throw new Error('Unknown admission result cannot be applied');
      const admitted = result.status === 'admitted' && result.resolved !== undefined;
      const now = new Date(receipt.recorded_at);
      const verifierContext = batch.input.solver2
        ? 'independent_model'
        : 'same_model_isolated_context';
      const persisted = await publishQuestionGroup(tx, {
        group_id: rootId,
        contract: admitted && result.resolved ? result.resolved : batch.input.contract,
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
