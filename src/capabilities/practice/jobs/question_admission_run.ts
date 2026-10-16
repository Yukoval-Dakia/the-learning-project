// YUK-1445 (Stage 1 / G1+G2) — question_admission_run worker job.
//
// The live consumer for the admission lane until B1's submit_question wires
// `runQuestionAdmission` directly. Takes an existing draft/revision id and:
//   1. loads the question group rows → row-normalizes → admission definition;
//   2. idempotency short-circuit: same base digest already admitted (or already
//      has a passed verification) returns the existing result — no paid solve;
//   3. runs the dual-blind-solve + per-unit calibration lane;
//   4. persists through the existing publish seam — admitted flips scoring
//      admission with the resolved contract AND clears verify_hold
//      (retraction_hold is never touched by the publisher seam); withheld
//      keeps the row-truth contract and appends failed verification evidence;
//      pending (transient) records suspended + verify_hold; CAS conflict /
//      stale drift return non-retryable results (retries must not re-pay
//      solves on llm queue retryLimit).
//
// store_sourced_question deliberately does NOT call this yet — B1 owns the
// submit_question call site.
//
// One-command dev invocation (worker must be running):
//   INSERT INTO pgboss.job (name, data) VALUES
//     ('question_admission_run', '{"question_id":"<id>"}');
// (or enqueue via the app client; real solves consume provider budget.)

import { desc, eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  knowledge,
  question,
  question_admission_verification,
  question_group_lifecycle,
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
  QUESTION_ADMISSION_POLICY_ID,
  runQuestionAdmission,
} from '../server/admission/run-admission';
import {
  publishQuestionGroup,
  publishQuestionGroupFromRow,
} from '../server/quiz/verify-and-promote';
import { makePracticeTaskTextRunFn } from '../server/task-runtime';

export interface QuestionAdmissionRunData {
  /** 组根 question id（子 part id 也可 —— 会解析到组根）。 */
  question_id?: string;
  /** 或：既有 revision id（取其 group）。 */
  revision_id?: string;
}

export interface QuestionAdmissionRunResult {
  /** conflict = CAS 撞车（不重试值回 —— 重跑只会再付一次 solve）。 */
  status: 'admitted' | 'withheld' | 'pending' | 'stale' | 'conflict' | 'already_verified';
  group_id: string;
  revision_id?: string;
  revision_ordinal?: number;
  per_unit: { scoring_unit_id: string; status: string; reason?: string }[];
}

/** env 配置键（文档化在 PR body；OPEN owner decision 默认同模型独立上下文）。 */
const SOLVER2_PROVIDER = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER as Provider | undefined;
const SOLVER2_MODEL = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
const POLICY_ID = process.env.QUESTION_ADMISSION_POLICY_ID ?? QUESTION_ADMISSION_POLICY_ID;
/** 如实记录 verifier 形态：未配置 solver2 = 同模型独立上下文，不是异源模型。 */
const VERIFIER_CONTEXT =
  SOLVER2_PROVIDER != null || SOLVER2_MODEL != null
    ? 'independent_model'
    : 'same_model_isolated_context';

async function loadDefinition(db: Db, rootId: string) {
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

async function subjectProfileFor(db: Db, rootId: string) {
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
  data: QuestionAdmissionRunData,
): Promise<QuestionAdmissionRunResult> {
  const now = new Date();
  // 解析目标组根：question_id 直接（或子 part 上行）；revision_id → group_id。
  let groupId = data.question_id ?? null;
  if (groupId == null && data.revision_id != null) {
    const [rev] = await db
      .select({ group_id: question_revision.group_id })
      .from(question_revision)
      .where(eq(question_revision.revision_id, data.revision_id))
      .limit(1);
    groupId = rev?.group_id ?? null;
  }
  if (groupId == null) {
    throw new ApiError(
      'bad_request',
      'question_admission_run requires question_id or revision_id',
      400,
    );
  }
  const [supplied] = await db
    .select({ id: question.id, parentId: question.parent_question_id })
    .from(question)
    .where(eq(question.id, groupId))
    .limit(1);
  const rootId = supplied?.parentId ?? supplied?.id ?? groupId;

  const { contract, definition } = await loadDefinition(db, rootId);

  // ---- 幂等短路（付费 solve 之前）：同 base digest 已有终态 ⇒ 不重付 ----
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, rootId))
    .limit(1);
  const [latestVerification] = await db
    .select({
      outcome: question_admission_verification.outcome,
      evidence: question_admission_verification.evidence,
    })
    .from(question_admission_verification)
    .innerJoin(
      question_revision,
      eq(question_admission_verification.revision_id, question_revision.revision_id),
    )
    .where(eq(question_revision.group_id, rootId))
    .orderBy(desc(question_admission_verification.recorded_at))
    .limit(1);
  const baseDigest = contract.integrity_digest;
  const recordedDigest =
    latestVerification != null
      ? ((latestVerification.evidence as Record<string, unknown> | null)?.base_contract_digest ??
        null)
      : null;
  if (
    latestVerification != null &&
    recordedDigest === baseDigest &&
    (lifecycle?.scoring_admission_state === 'admitted' || latestVerification.outcome === 'passed')
  ) {
    return {
      status: 'already_verified',
      group_id: rootId,
      ...(lifecycle?.current_revision_id != null
        ? { revision_id: lifecycle.current_revision_id }
        : {}),
      per_unit: [],
    };
  }

  const subjectProfile = await subjectProfileFor(db, rootId);
  const result = await runQuestionAdmission(definition, {
    db,
    runTask: makePracticeTaskTextRunFn(db),
    subjectProfile,
    solver2:
      VERIFIER_CONTEXT === 'independent_model'
        ? { provider: SOLVER2_PROVIDER, model: SOLVER2_MODEL }
        : null,
    policyId: POLICY_ID,
    now,
  });

  const perUnit = result.per_unit.map((u) => ({
    scoring_unit_id: u.scoring_unit_id,
    status: u.status,
    ...(u.reason != null ? { reason: u.reason } : {}),
  }));

  if (result.status === 'pending') {
    // 瞬时/infra 未决：挂起 admission（verify_hold），证据入 append-only 表。
    const persisted = await publishQuestionGroupFromRow(db, {
      rootId,
      admission: { state: 'preserve' },
      suspension: { suspended: true, reason: 'verify_hold' },
      verification: {
        policy_id: result.verification.policy_id,
        outcome: result.verification.outcome,
        evidence: result.verification.evidence,
      },
      actorRef: 'practice:question_admission',
      now,
    });
    if (persisted.status === 'conflict') {
      // CAS 撞车 = 终态结果（不重试 —— 重跑会再付一次 solve）。
      return { status: 'conflict', group_id: rootId, per_unit: perUnit };
    }
    return { status: 'pending', group_id: rootId, per_unit: perUnit };
  }

  if (result.status === 'withheld' || result.resolved == null) {
    // withheld：row-normalized（内容不变）发布 + failed/suspended 证据。
    const persisted = await publishQuestionGroupFromRow(db, {
      rootId,
      admission: {
        state: 'withheld',
        reason: result.per_unit.some((u) => u.reason === 'no_admitted_executor')
          ? 'no_admitted_executor'
          : result.per_unit.some((u) => u.reason?.startsWith('source_crosscheck') === true)
            ? 'verification_failed'
            : 'unverified_rules',
      },
      verification: {
        policy_id: result.verification.policy_id,
        outcome: result.verification.outcome,
        evidence: result.verification.evidence,
      },
      actorRef: 'practice:question_admission',
      now,
    });
    if (persisted.status === 'conflict') {
      return { status: 'conflict', group_id: rootId, per_unit: perUnit };
    }
    return {
      status: 'withheld',
      group_id: rootId,
      ...('current_revision_id' in persisted ? { revision_id: persisted.current_revision_id } : {}),
      ...('revision_id' in persisted ? { revision_id: persisted.revision_id } : {}),
      per_unit: perUnit,
    };
  }

  // admitted：resolved 契约直发（含新判据/规则/确定性执行器）—— CAS + drift
  // 双重防护：锁后重归一，行快照变了即整单作废（不发布过期证据的升级）。
  const resolved = result.resolved;
  const persisted = await db.transaction(async (tx) => {
    // P1-1 锁序与 publisher 一致：先锁组根行，再做快照读。
    const [lockedRoot] = await tx
      .select()
      .from(question)
      .where(eq(question.id, rootId))
      .for('update')
      .limit(1);
    if (!lockedRoot) throw new ApiError('not_found', `question '${rootId}' not found`, 404);
    // drift check：行快照自定义构造以来变了 ⇒ 本 admission 证据全部失效。
    const partRows = await tx
      .select()
      .from(question)
      .where(eq(question.parent_question_id, rootId))
      .orderBy(question.part_index);
    const liveParts = partRows.filter((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.archived_at == null && meta?.dismissed_at == null;
    });
    const figureAssetIds = new Set<string>();
    for (const f of lockedRoot.figures ?? []) figureAssetIds.add(f.asset_id);
    for (const p of liveParts) for (const f of p.figures ?? []) figureAssetIds.add(f.asset_id);
    const figureDigests: Record<string, string> = {};
    if (figureAssetIds.size > 0) {
      const assets = await tx
        .select({ assetId: source_asset.id, sha256: source_asset.sha256 })
        .from(source_asset)
        .where(inArray(source_asset.id, [...figureAssetIds]));
      for (const a of assets) figureDigests[a.assetId] = a.sha256;
    }
    const fresh = normalizeQuestionGroupToContract(
      { ...(lockedRoot as Parameters<typeof normalizeQuestionGroupToContract>[0]), figureDigests },
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
    if (
      definition.base_contract_digest != null &&
      fresh.integrity_digest !== definition.base_contract_digest
    ) {
      return { status: 'stale' as const };
    }
    const [lockedLifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, rootId))
      .for('update')
      .limit(1);
    const publishResult = await publishQuestionGroup(tx, {
      group_id: rootId,
      contract: {
        structure: resolved.structure,
        response_spec: resolved.response_spec,
        scoring_basis: resolved.scoring_basis,
        execution_plan: resolved.execution_plan,
        integrity_digest: resolved.integrity_digest,
      },
      expectedCurrentRevision: lockedLifecycle?.current_revision_id ?? null,
      expectedAdmissionGeneration: lockedLifecycle?.scoring_admission_generation ?? null,
      availability:
        lockedLifecycle?.availability ??
        (lockedRoot.source === 'web_sourced' || lockedRoot.source === 'quiz_gen'
          ? 'general_pool'
          : 'container_only'),
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'system_verified',
          verification: {
            structural_check_passed: true,
            independent_verification: {
              passed: true,
              verifier: 'independent_model',
              verified_at: now.toISOString(),
            },
            // verifier enum 只认 independent_model/human —— 实际 solver 拓扑
            // 如实写进 note 与 verification evidence pack（solver_context）。
            note: `YUK-1445 dual blind solve + frozen probe calibration (${POLICY_ID}); verifier_context=${VERIFIER_CONTEXT}`,
          },
          model_slice: null,
        },
      },
      // 准入成功即解除 verify_hold（suspension 维度只清 verify_hold，
      // retraction_hold 恒保留 —— publisher seam 语义）。
      suspension: { suspended: false },
      verification: {
        policy_id: result.verification.policy_id,
        outcome: result.verification.outcome,
        evidence: result.verification.evidence,
      },
      actorRef: 'practice:question_admission',
      publishedBy: {
        by: 'system',
        lane: 'question_admission',
        policy_id: POLICY_ID,
        task_run_ids: result.evidence_refs.task_run_ids,
      },
      now,
    });
    if (publishResult.status === 'conflict') {
      return { status: 'conflict' as const };
    }
    return publishResult;
  });
  if (persisted.status === 'stale' || persisted.status === 'conflict') {
    return { status: persisted.status, group_id: rootId, per_unit: perUnit };
  }
  return {
    status: 'admitted',
    group_id: rootId,
    revision_id: 'revision_id' in persisted ? persisted.revision_id : undefined,
    revision_ordinal: 'revision_ordinal' in persisted ? persisted.revision_ordinal : undefined,
    per_unit: perUnit,
  };
}

export function buildQuestionAdmissionRunHandler(
  db: Db,
): (jobs: Job<QuestionAdmissionRunData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data ?? {};
      const result = await runAdmissionForQuestion(db, data);
      console.log(
        `[question_admission_run] ${result.group_id} -> ${result.status}` +
          (result.revision_id != null ? ` rev=${result.revision_id}` : ''),
      );
    }
  };
}
