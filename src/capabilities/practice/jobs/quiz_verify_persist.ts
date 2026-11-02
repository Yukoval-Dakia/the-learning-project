// Terminal writes for one quiz_verify delivery: the deterministic precheck hold,
// the promote/hold verdict transaction, and the retriable system-failure mark.
// quiz_verify.ts still owns loading, paid calls, and the promote gate.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { TaskTextResult } from '@/ai/task-result';
import { QUESTION_ADMISSION_POLICY_IDS } from '@/core/question-admission-policy';
import {
  LEGACY_DRAFT_STATUS,
  QUESTION_AVAILABILITY,
  SCORING_ADMISSION_STATE,
  SCORING_ADMISSION_WITHHELD_REASON,
  SUSPENSION_REASON,
} from '@/core/schema/assessment/lifecycle';
import type { SourceTier } from '@/core/schema/provenance';
import {
  QuizGenMetadata,
  type QuizGenMetadataT,
  type QuizGenVerificationT,
  type QuizVerificationResultT,
} from '@/core/schema/quiz_gen';
import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  event,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  appendAdmissionVerificationRecord,
  publishQuestionGroup,
  publishQuestionGroupFromRow,
} from '@/kernel/records/assessment-publication';
import { resolveQuestionAdmissionPolicyId } from '../server/admission/run-admission';
import { enrollPromotedQuestionScheduling } from '../server/question-scheduling-enrollment';
import type { SupplyTraceV1T } from '../server/question-supply/evidence-demand';
import {
  type PlacementVerificationAuthority,
  assertPlacementAuthority,
} from '../server/question-supply/placement-starter-attempts';
import { lockPlacementSupplyScopes } from '../server/question-supply/placement-supply-lock';
import type {
  ChoiceSurfacePrecheckRecord,
  ChoiceSurfaceRuleCheck,
} from '../server/quiz/choice-surface';
import type {
  SolveCheckResult,
  TeachingQualityResult,
  VerifyCheck,
} from '../server/quiz/verify-framework';

async function promoteCompositeChildren(
  tx: Tx,
  input: {
    questionId: string;
    now: Date;
    verifiedBy: QuizGenVerificationT['verified_by'];
    verifyEventId: string;
  },
): Promise<void> {
  const { questionId, now, verifiedBy, verifyEventId } = input;
  const childRows = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      metadata: question.metadata,
      knowledgeIds: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.parent_question_id, questionId));
  for (const child of childRows) {
    if (child.draftStatus !== 'draft') continue;
    const childMeta =
      child.metadata && typeof child.metadata === 'object'
        ? (child.metadata as Record<string, unknown>)
        : {};
    // Read-side tombstone skip (fast path for rows already dead when read;
    // the write-side WHERE below enforces the same check atomically).
    if (childMeta.archived_at != null || childMeta.dismissed_at != null) continue;
    // Stamp the child's own verification block — honest provenance: the
    // part was not independently verified; it inherits the parent's
    // verdict (the group was judged as a unit). Same contract as the
    // verified parent: every child this cascade promotes was written by the
    // Q3 path and always carries a parseable metadata.quiz_gen — anything
    // else is a contract violation → throw rather than silently promote
    // an unverifiable draft.
    const childQuizGen = QuizGenMetadata.safeParse(childMeta.quiz_gen);
    if (!childQuizGen.success) {
      throw new Error(
        `runQuizVerify: composite child ${child.id} of ${questionId} has no valid metadata.quiz_gen: ${childQuizGen.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
    }
    const childMetadata = {
      ...childMeta,
      quiz_gen: {
        ...childQuizGen.data,
        verification: {
          status: 'verified' as const,
          summary: 'composite child promoted with verified parent',
          verified_by: verifiedBy,
        },
      },
    };
    // The draft/tombstone predicates are enforced in the UPDATE's WHERE
    // (not only the SELECT above) so a concurrent archive/dismiss landing
    // between read and write cannot be overwritten back to 'active' — the
    // "a dead part must not resurrect" invariant holds at write time, and
    // a zero-row result also skips the FSRS enroll below.
    const promotedChildren = await tx
      .update(question)
      .set({
        draft_status: LEGACY_DRAFT_STATUS.ACTIVE,
        metadata: childMetadata as never,
        updated_at: now,
      })
      .where(
        and(
          eq(question.id, child.id),
          eq(question.draft_status, LEGACY_DRAFT_STATUS.DRAFT),
          sql`${question.metadata}->>'archived_at' IS NULL`,
          sql`${question.metadata}->>'dismissed_at' IS NULL`,
        ),
      )
      .returning({ id: question.id });
    if (promotedChildren.length === 0) continue;
    await enrollPromotedQuestionScheduling(tx, {
      questionId: child.id,
      knowledgeIds: child.knowledgeIds ?? [],
      evidenceEventId: verifyEventId,
      now,
    });
  }
}

/**
 * 同事务判定组是否已被 C1（question_admission_run）独立准入。
 * 锁序 root question → lifecycle（与 publisher/C1 一致；调用方须已持根行锁）。
 * 命中条件（判据与 source_verify 的 pair-race guard 相同，外加 generation 下界）：
 *   0. lifecycle.scoring_admission_generation 严格大于 `newerThanGeneration`
 *      （null = 不设下界，任何 admitted 生命周期都算）。调用方在 verify 开工前
 *      快照 admission generation，只有【晚于快照】的准入决定才证明本投递的
 *      验证相对较新 admission 决定 stale —— verify 开始前已存在的 admitted
 *      不提供该证明（C1 只证判分、不证内容质检，首次真失败仍须挂起）。
 *   1. lifecycle.scoring_admission_state === 'admitted'；
 *   2.【当前 revision】上存在 policy question_admission@*、outcome='passed' 的
 *      question_admission_verification 行（不匹配历史其他 revision 的 passed 行）；
 *   3. 该行绑定当前已发布 revision 的 integrity_digest —— 权威绑定取 publisher
 *      写入的 revision_digest 列（resolved 发布后
 *      evidence.base_contract_digest 是付费【输入】摘要，不再等于发布摘要）；
 *      旧证据字段仅作 base==published 行的兼容回退。
 * 命中 ⇒ 返回锁后 lifecycle 行与当前 revision id；未命中 ⇒ null。
 */
async function readBoundIndependentAdmission(
  tx: Tx,
  groupRootId: string,
  newerThanGeneration: number | null,
): Promise<{
  lifecycle: typeof question_group_lifecycle.$inferSelect;
  revisionId: string;
} | null> {
  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupRootId))
    .for('update')
    .limit(1);
  if (
    lifecycle == null ||
    lifecycle.scoring_admission_state !== SCORING_ADMISSION_STATE.ADMITTED ||
    lifecycle.current_revision_id == null ||
    (newerThanGeneration != null && lifecycle.scoring_admission_generation <= newerThanGeneration)
  ) {
    return null;
  }
  const revisionId = lifecycle.current_revision_id;
  const [c1Passed] = await tx
    .select({
      evidence: question_admission_verification.evidence,
      revisionDigest: question_admission_verification.revision_digest,
    })
    .from(question_admission_verification)
    .where(
      and(
        eq(question_admission_verification.revision_id, revisionId),
        inArray(question_admission_verification.policy_id, [
          ...QUESTION_ADMISSION_POLICY_IDS,
          resolveQuestionAdmissionPolicyId(),
        ]),
        eq(question_admission_verification.outcome, 'passed'),
      ),
    )
    .orderBy(desc(question_admission_verification.recorded_at))
    .limit(1);
  if (c1Passed == null) return null;
  const recordedBaseDigest =
    (c1Passed.evidence as Record<string, unknown> | null)?.base_contract_digest ?? null;
  const [publishedRevision] = await tx
    .select({ integrity_digest: question_revision.integrity_digest })
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId))
    .limit(1);
  const boundToCurrent =
    publishedRevision != null &&
    (c1Passed.revisionDigest === publishedRevision.integrity_digest ||
      publishedRevision.integrity_digest === recordedBaseDigest);
  return boundToCurrent ? { lifecycle, revisionId } : null;
}

/**
 * shared concurrent-success predicate for verify terminal writes: a
 * success event bound to the CURRENT admission generation proves a duplicate
 * delivery is stale. See the main select for the full rationale.
 */
function promotedElsewhereEventExists(questionId: string) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${event}
    WHERE ${event.action} = 'experimental:quiz_verify'
      AND ${event.subject_kind} = 'question'
      AND ${event.subject_id} = ${questionId}
      AND ${event.outcome} = 'success'
      AND (${event.payload}->>'admission_generation')::text = (
        SELECT ${question_group_lifecycle.scoring_admission_generation}::text
        FROM ${question_group_lifecycle}
        WHERE ${question_group_lifecycle.group_id} = ${questionId}
      )
  )`;
}

/**
 * terminal write for a draft whose deterministic choice-surface
 * pre-check rejected. Zero paid calls were spent, so there is no model verdict to
 * record: the event honestly reports a rules-only needs_review and the draft is
 * held for human review exactly like a model needs_review (verify_hold +
 * unverified_rules; a rules defect is not promoted to a proven failure because
 * the check could still mis-shape an unusual-but-valid item). The per-rule
 * precheck record (name + verdict + reason) lands in the admission
 * verification evidence — PM condition: every precheck outcome, reject or pass,
 * is auditable on the admission record. Deliberately outside the main
 * failure-bottom: this path has no minutes-long model window, so a rare throw
 * (version race) simply falls back to pg-boss retry with no terminal event
 * written for the idempotency guard to trip over.
 */
export async function finalizeDeterministicPrecheckFailure(input: {
  db: Db;
  row: typeof question.$inferSelect;
  metadataRaw: Record<string, unknown>;
  meta: QuizGenMetadataT;
  precheckChecks: ChoiceSurfaceRuleCheck[];
  precheckRecord: ChoiceSurfacePrecheckRecord;
  sourceTier: number;
  admissionGenerationAtStart: number | undefined;
  supplyTrace?: SupplyTraceV1T;
  difficultyEvidence?: unknown;
}): Promise<{
  status: 'needs_review';
  overall: 'needs_review';
  copy_safety_verdict: QuizGenMetadataT['copy_safety']['verdict'];
}> {
  const { db, row, meta, metadataRaw, precheckChecks, precheckRecord } = input;
  const questionId = row.id;
  const now = new Date();
  const verifyEventId = createId();
  const rejectedRules = precheckChecks
    .filter((check) => check.verdict === 'reject')
    .map((check) => check.rule)
    .join('、');
  const summary = `quiz_verify 确定性预检未通过（${rejectedRules}）；未运行付费核验，留人工复核。`;
  const verifiedBy = { by: 'system' as const, task_kind: 'quiz_verify' };
  const verification: QuizGenVerificationT = {
    status: 'needs_review',
    summary,
    verified_by: verifiedBy,
  };
  const newMetadata = {
    ...metadataRaw,
    quiz_gen: { ...meta, verification } satisfies QuizGenMetadataT,
  };
  const unified = toUnifiedVerifyResult({
    source: 'quiz',
    overall: 'needs_review',
    promote: false,
    summary_md: summary,
    confidence: 1,
    checks: [],
  });

  await db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    await lockPlacementSupplyScopes(tx, row.knowledge_ids ?? []);
    const [current] = await tx
      .select({
        version: question.version,
        promotedElsewhere: promotedElsewhereEventExists(questionId),
      })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1)
      .for('update');
    if (!current || current.version !== row.version) {
      throw new Error(
        `quiz_verify pre-check question ${questionId} changed during verification (expected version ${row.version}, got ${current?.version ?? 'missing'})`,
      );
    }
    await tx
      .update(question)
      .set({ metadata: newMetadata as never, updated_at: now })
      .where(eq(question.id, questionId));
    if (!current.promotedElsewhere) {
      // Same stale-admission semantics as the model needs_review branch: an
      // independent C1 admission decided after this delivery started must not
      // be folded back into verify_hold.
      const staleAgainstAdmission = await readBoundIndependentAdmission(
        tx,
        row.parent_question_id ?? questionId,
        input.admissionGenerationAtStart ?? null,
      );
      if (staleAgainstAdmission == null) {
        await publishQuestionGroupFromRow(tx, {
          rootId: row.parent_question_id ?? questionId,
          admission: {
            state: SCORING_ADMISSION_STATE.WITHHELD,
            reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
          },
          suspension: { suspended: true, reason: SUSPENSION_REASON.VERIFY_HOLD },
          verification: {
            policy_id: 'quiz_verify@1',
            outcome: 'suspended',
            evidence: {
              overall: 'needs_review',
              deterministic_precheck: { ...precheckRecord, paid_calls_skipped: true },
            },
          },
          actorRef: 'quiz_verify:suspend',
          now,
        });
      }
    }
    await writeEvent(tx, {
      id: verifyEventId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'quiz_verify',
      action: 'experimental:quiz_verify',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'partial',
      payload: {
        question_id: questionId,
        ...unified,
        deterministic_precheck: { ...precheckRecord, paid_calls_skipped: true },
        copy_safety: {
          llm_verdict: null,
          persisted_verdict: meta.copy_safety.verdict,
        },
        source_tier: input.sourceTier,
        promoted: false,
        verification_status: 'needs_review',
        verified_by: verifiedBy,
        ...(input.difficultyEvidence ? { difficulty_evidence: input.difficultyEvidence } : {}),
        ...(input.supplyTrace ? { supply_trace: input.supplyTrace } : {}),
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
  });

  return {
    status: 'needs_review',
    overall: 'needs_review',
    copy_safety_verdict: meta.copy_safety.verdict,
  };
}

interface PersistQuizVerifyVerdictInput {
  db: Db;
  questionId: string;
  row: typeof question.$inferSelect;
  placementAuthority: PlacementVerificationAuthority | undefined;
  now: Date;
  newMetadata: { quiz_gen: QuizGenMetadataT };
  promote: boolean;
  verifyEventId: string;
  verifiedBy: QuizGenVerificationT['verified_by'];
  parsed: QuizVerificationResultT;
  copySafetyVerdict: QuizGenMetadataT['copy_safety']['verdict'];
  precheckRecord: ChoiceSurfacePrecheckRecord;
  solveCheckOk: boolean;
  teachingQualityOk: boolean;
  admissionGenerationAtStart: number | undefined;
  unified: ReturnType<typeof toUnifiedVerifyResult>;
  deterministicTooClose: boolean;
  maxOverlap: number;
  tier: SourceTier;
  tierChecks: readonly VerifyCheck[];
  meta: QuizGenMetadataT;
  materialPresent: boolean;
  verifySkillDocs: { name: string; body: string }[] | undefined;
  solveResult: SolveCheckResult | undefined;
  teachingResult: TeachingQualityResult | undefined;
  verificationStatus: QuizGenVerificationT['status'];
  difficultyEvidence: unknown;
  supplyTrace: SupplyTraceV1T | undefined;
  taskRunId: string | null;
  costMicroUsd: number | null;
}

export async function persistQuizVerifyVerdict(
  input: PersistQuizVerifyVerdictInput,
): Promise<void> {
  const {
    db,
    questionId,
    row,
    placementAuthority,
    now,
    newMetadata,
    promote,
    verifyEventId,
    verifiedBy,
    parsed,
    copySafetyVerdict,
    precheckRecord,
    solveCheckOk,
    teachingQualityOk,
    admissionGenerationAtStart,
    unified,
    deterministicTooClose,
    maxOverlap,
    tier,
    tierChecks,
    meta,
    materialPresent,
    verifySkillDocs,
    solveResult,
    teachingResult,
    verificationStatus,
    difficultyEvidence,
    supplyTrace,
    taskRunId,
    costMicroUsd,
  } = input;

  await db.transaction(async (tx) => {
    // global learning-state write lock FIRST (shared tx-entry order with every
    // material_fsrs_state / mastery_state writer and the cascade revert).
    await acquireLearningStateWriteLock(tx);
    // G→row lock order: acquire the placement supply scope lock BEFORE
    // the question row lock, matching placement paid admission (which takes this advisory lock
    // then a plain SELECT) and proposal-appliers. The prior order (row lock, then supply lock only
    // inside the promote branch) let a concurrent /placement/start read the draft as still-cold
    // while this tx waited on the advisory lock, then promote after it enqueued paid work — a
    // double-supply race. Locking row.knowledge_ids (pre-tx snapshot) is safe: if attribution
    // drifted, the version guard below throws and pg-boss reruns against the fresh scope.
    await lockPlacementSupplyScopes(tx, row.knowledge_ids ?? []);
    if (placementAuthority) {
      await assertPlacementAuthority(tx, placementAuthority, now);
    }
    // Serialize the terminal verdict against cross-KC duplicate reconciliation. The model and
    // deterministic checks above ran against `row.version`; if attribution changed meanwhile,
    // this verdict is stale. Throwing writes a retriable outcome='error' event in the catch and
    // lets pg-boss rerun verification against the new KC snapshot. Lock ordering also gives the
    // opposite race a safe result: once this lock wins and promotes, reconciliation observes an
    // active row and enrolls any newly-added KC itself.
    const [current] = await tx
      .select({
        version: question.version,
        knowledgeIds: question.knowledge_ids,
        // 并发终验成功（重叠投递）：它已提交 ⇒ 本投递 stale，挂起
        // 写须跳过（旧验证不能改变较新 admission 决定）。
        // 判据绑定【当前 admission generation】：成功事件在 promote
        // 时盖上写入后的 generation，只有 generation == 当前值的 success 才算
        // 并发副本。历史上任意 success（无 generation 限定）会让一次真正失败的
        // 重验被旧记录跳过 —— 旧验证不得冒充较新 admission 决定的并发副本。
        promotedElsewhere: promotedElsewhereEventExists(questionId),
      })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1)
      .for('update');
    if (!current || current.version !== row.version) {
      throw new Error(
        `quiz_verify question ${questionId} changed during verification (expected version ${row.version}, got ${current?.version ?? 'missing'})`,
      );
    }
    // 本次 promote 写入后的 admission generation（成功事件盖上，供
    // 并发 promotedElsewhere 判据绑定）；非 promote 路径恒为 null，不落该字段。
    // kept 路径（组已被 C1 独立准入）盖【当前】admission generation：
    // 本成功与现行独立准入决定同代绑定，同代 stale 失败投递仍被 promotedElsewhere
    // 挡下；generation 再推进（新 revision 决定）后 shield 自动失效。
    let promotedAdmissionGeneration: number | null = null;
    // C1 绑定准入命中时记录保留的 revision id（事件审计标记；
    // 成功分支不重发，失败分支仅在准入决定晚于本投递开工时不折叠/挂起）。
    // 见下方两处 publish gate。
    let keptIndependentAdmissionRevisionId: string | null = null;
    if (promote) {
      // Supply scope already locked at the top of this tx (G→row order above).
      // Promote draft→active.
      await tx
        .update(question)
        .set({
          draft_status: LEGACY_DRAFT_STATUS.ACTIVE,
          metadata: newMetadata as never,
          updated_at: now,
        })
        .where(eq(question.id, questionId));

      await enrollPromotedQuestionScheduling(tx, {
        questionId,
        knowledgeIds: current.knowledgeIds ?? [],
        evidenceEventId: verifyEventId,
        now,
      });

      // composite cascade: a verified composite parent (quiz_gen
      // 篇 output carries question_part children persisted as 'draft' with NO
      // independent verify intent) promotes its draft children in the SAME tx
      // so the group enters the pool atomically. Tombstoned children
      // (archived/dismissed) are skipped — a dead part must not resurrect.
      // Children inherit the parent's knowledge_ids at write time (ADR-0028
      // U0 A2), so they enroll on the SAME knowledge projection as the parent
      // (per-KC enroll-if-absent — usually a no-op since the parent's loop
      // above just enrolled those ids); the question-level fallback stays
      // reserved for a genuinely unlabeled legacy part.
      await promoteCompositeChildren(tx, {
        questionId,
        now,
        verifiedBy,
        verifyEventId,
      });

      // 统一发布链：verified promote 同事务重发组 revision（位于级联
      // 之后 ⇒ 组契约含最终子 part 状态）。composite 的组根 = 父行。
      // 验证通过 ≠ 判分准入（ADR-0073 四源同门：每个计分单元要两次
      // 独立解题一致 + 逐单元标定才 admitted）。本 job 的独立模型核验只是内容
      // 质检证据，故发布为 withheld(unverified_rules)＝待准入，保留
      // quiz_verify@1 的 passed 核验记录；question_admission_run
      // 经 assessment_publish outbox 订阅自动入队，双解 + 标定通过后才
      // admitted。已发布过同内容的组在此只更新 admission 维度（generation+1）。
      // suspension:false 清 verify_hold（同版复核通过 ⇒ 幂等恢复，
      // 「同版复核通过」行）；retraction_hold 不由本路径接线，publisher 恒保留。
      const groupRootId = row.parent_question_id ?? questionId;
      // pair-race guard（同 source_verify 判据，下界传 null 即不设
      // 代差要求）：【任何】绑定当前已发布 revision 的 C1 独立准入都不得被重
      // 发 —— 不把 admitted 降回 withheld，也不把行归一 base 重铸到 C1 的
      // resolved revision 上（重铸还会经 withheld 事件触发一次无收益的重复
      // 付费准入）。这是「不重铸现行绑定准入」的完整性保护，与失败分支的
      // stale 判定（要求准入决定晚于本投递开工）是两种语义，不要混用下界。
      // 其余情况（C1 准入的是更老 base 后行又变了、他 policy 准入、未准入）
      // 照常走 withheld 发布。
      const keptAdmission = await readBoundIndependentAdmission(tx, groupRootId, null);
      if (keptAdmission != null) {
        keptIndependentAdmissionRevisionId = keptAdmission.revisionId;
        promotedAdmissionGeneration = keptAdmission.lifecycle.scoring_admission_generation;
        // verify_hold 角：C1 admitted 的发布本已清 verify_hold；若此刻仍挂
        // （跨 lane 再挂起），经 publisher 既有 dimension-only 路径清除（digest
        // 不变 ⇒ admission_updated，不铸新 revision），admission 状态与证据
        // 原样保留（显式回传当前 admitted 维度）。
        if (
          keptAdmission.lifecycle.suspended === true &&
          keptAdmission.lifecycle.suspension_reason === SUSPENSION_REASON.VERIFY_HOLD
        ) {
          const [currentRevision] = await tx
            .select()
            .from(question_revision)
            .where(eq(question_revision.revision_id, keptAdmission.revisionId))
            .limit(1);
          if (currentRevision == null) {
            throw new Error(
              `quiz_verify: current revision '${keptAdmission.revisionId}' missing for group '${groupRootId}'`,
            );
          }
          const cleared = await publishQuestionGroup(tx, {
            group_id: groupRootId,
            readAssetBytes: async (storageKey) => {
              const { getR2 } = await import('@/kernel/object-storage');
              return getR2().get(storageKey);
            },
            contract: {
              structure: currentRevision.structure,
              response_spec: currentRevision.response_spec,
              scoring_basis: currentRevision.scoring_basis,
              execution_plan: currentRevision.execution_plan,
              ...(currentRevision.presentation != null
                ? { presentation: currentRevision.presentation }
                : {}),
              integrity_digest: currentRevision.integrity_digest,
            },
            expectedCurrentRevision: currentRevision.revision_id,
            expectedAdmissionGeneration: keptAdmission.lifecycle.scoring_admission_generation,
            availability: keptAdmission.lifecycle.availability,
            admission: {
              state: 'admitted',
              evidence: keptAdmission.lifecycle.scoring_admission_evidence ?? null,
            },
            suspension: { suspended: false },
            verification: {
              policy_id: 'quiz_verify@1',
              outcome: 'passed',
              evidence: {
                overall: parsed.overall,
                copy_safety: copySafetyVerdict,
                admission: 'kept_independent_admission',
                deterministic_precheck: precheckRecord,
              },
            },
            actorRef: 'quiz_verify:promote',
            now,
          });
          if (cleared.status === 'conflict') {
            // 锁后读取 ⇒ 不该发生；出现即外部路径越过 seam 写 lifecycle ——
            // fail-closed 回滚（同 FromRow 的 conflict 处理）。
            throw new Error(
              `quiz_verify: unexpected ${cleared.reason} conflict clearing verify_hold for group '${groupRootId}'`,
            );
          }
          if ('admission_generation' in cleared) {
            promotedAdmissionGeneration = cleared.admission_generation;
          }
        } else {
          // （PM 条件）——无 verify_hold 可清的 kept 分支也要给这次
          // verify 结果落一条 append-only 记录：不改任何 lifecycle 维度、
          // 不推进 generation（readBoundIndependentAdmission 已锁 lifecycle 行）。
          await appendAdmissionVerificationRecord(tx, {
            groupId: groupRootId,
            expectedRevisionId: keptAdmission.revisionId,
            expectedGeneration: keptAdmission.lifecycle.scoring_admission_generation,
            verification: {
              policy_id: 'quiz_verify@1',
              outcome: 'passed',
              evidence: {
                overall: parsed.overall,
                copy_safety: copySafetyVerdict,
                admission: 'kept_independent_admission',
                deterministic_precheck: precheckRecord,
              },
            },
            now,
          });
        }
      } else {
        const promotePublish = await publishQuestionGroupFromRow(tx, {
          rootId: groupRootId,
          admission: {
            state: SCORING_ADMISSION_STATE.WITHHELD,
            reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
          },
          suspension: { suspended: false },
          verification: {
            policy_id: 'quiz_verify@1',
            outcome: 'passed',
            evidence: {
              overall: parsed.overall,
              copy_safety: copySafetyVerdict,
              deterministic_precheck: precheckRecord,
            },
          },
          availability: QUESTION_AVAILABILITY.GENERAL_POOL,
          actorRef: 'quiz_verify:promote',
          now,
        });
        promotedAdmissionGeneration =
          'admission_generation' in promotePublish ? promotePublish.admission_generation : null;
      }
    } else {
      // needs_review / fail / too_close / solve_check veto — stay draft, never reaches
      // the pool.
      // quiz_verify has NO demote branch (unlike
      // source_verify.ts's active→draft demote) and that is SAFE: no path
      // pre-promotes a quiz_gen row to active before quiz_verify runs (cold-start
      // image-candidate-accept hardcodes web_sourced→source_verify;
      // verify-and-promote/proposal-appliers/legacy-record-appliers active-writers never
      // target an unverified quiz_gen draft). The new solve_check veto lands in this
      // existing else and only writes metadata/updated_at — draft_status is never touched
      // (a solve-vetoed row was already 'draft'), so no demote is needed.
      await tx
        .update(question)
        .set({
          metadata: newMetadata as never,
          updated_at: now,
        })
        .where(eq(question.id, questionId));

      // verify 挂起串行化：needs_review/fail/too_close 同事务
      // 把 contract 维度翻 suspended（verify_hold）+ admission 折叠 withheld；
      // claim 不释放（挂起 ≠ 撤回）。draft 行从池读面消失由 draft_status 既覆盖；
      // 本写保证 contract 读面 + admission generation 串行化语义存在。组未发布
      // 时铸 suspended 首版；同版复核通过后 promote 分支（上方）解除挂起。
      // promotedElsewhere ⇒ 并发终验成功已提交 ⇒ 本投递 stale，不翻维度也不写
      // 核验记录（记录诚实归属本轮核验的 generation）。
      // promotedElsewhere 的 generation 绑定盖不住一种新交错：先前
      // 成功投递记的是它写的 withheld generation，C1 admitted 会把 generation
      // 再推进一代 ⇒ 迟到的失败投递看到「无当前代 success」而误判非 stale。
      // 故另查 live lifecycle，但 stale 判定是因果绑定，不是「当前有 C1
      // passed」：只有【绑定当前 revision 且 generation 严格晚于本投递开工
      // 快照（admissionGenerationAtStart）】的准入决定，才证明本投递的验证
      // 相对较新 admission 决定 stale（旧验证不改变较新决定）⇒ 不折叠
      // admitted 也不挂 verify_hold。verify 开工前已存在的 admitted 不提供
      // 该证明 —— C1 只证判分、不证内容质检（grounding/copy_safety/
      // knowledge_hit），本投递若是首次真实核验，其失败仍照常挂起。事件仍
      // 如实写（含 kept 审计标记，仅当确证 stale 时）。
      const verifyFailed =
        parsed.overall === 'fail' ||
        copySafetyVerdict === 'too_close' ||
        solveCheckOk === false ||
        teachingQualityOk === false;
      if (!current.promotedElsewhere) {
        const staleAgainstAdmission = await readBoundIndependentAdmission(
          tx,
          row.parent_question_id ?? questionId,
          admissionGenerationAtStart ?? null,
        );
        if (staleAgainstAdmission != null) {
          keptIndependentAdmissionRevisionId = staleAgainstAdmission.revisionId;
        } else {
          await publishQuestionGroupFromRow(tx, {
            rootId: row.parent_question_id ?? questionId,
            admission: {
              state: SCORING_ADMISSION_STATE.WITHHELD,
              reason: verifyFailed
                ? SCORING_ADMISSION_WITHHELD_REASON.VERIFICATION_FAILED
                : SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
            },
            suspension: { suspended: true, reason: SUSPENSION_REASON.VERIFY_HOLD },
            verification: {
              policy_id: 'quiz_verify@1',
              outcome: verifyFailed ? 'failed' : 'suspended',
              evidence: {
                overall: parsed.overall,
                copy_safety: copySafetyVerdict,
                deterministic_precheck: precheckRecord,
              },
            },
            actorRef: 'quiz_verify:suspend',
            now,
          });
        }
      }
    }

    if (placementAuthority) {
      await assertPlacementAuthority(tx, placementAuthority, now);
    }

    await writeEvent(tx, {
      id: verifyEventId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'quiz_verify',
      action: 'experimental:quiz_verify',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: promote ? 'success' : parsed.overall === 'fail' ? 'failure' : 'partial',
      payload: {
        question_id: questionId,
        // unified verify contract shape (axes + overall +
        // failure_class? + summary_md + confidence). SUPERSET: every handler-specific
        // key below stays unchanged. `unified.overall` === `parsed.overall` and
        // `unified.failure_class` (validation_failure when !promote) reproduce the
        // prior inline values byte-identically; the only new key is `axes`.
        ...unified,
        grounding: parsed.grounding,
        knowledge_hit: parsed.knowledge_hit,
        copy_safety: {
          llm_verdict: parsed.copy_safety.verdict,
          persisted_verdict: copySafetyVerdict,
          max_overlap: maxOverlap,
          deterministic_too_close: deterministicTooClose,
        },
        // precheck per-rule record on every terminal event, pass or
        // reject (mirrors the admission verification evidence above).
        deterministic_precheck: precheckRecord,
        // source tier + the tier-3 material_grounding outcome (audit trail).
        source_tier: tier,
        ...(tierChecks.includes('material_grounding')
          ? {
              material_grounding: {
                material_source_document_id: meta.material_source_document_id ?? null,
                material_present: materialPresent,
                // F2 — the verifier's relevance verdict (题是否真考这份素材), null when
                // the verifier did not emit it (no material fed / older output).
                verdict: parsed.material_grounding?.verdict ?? null,
              },
            }
          : {}),
        // kind_conformance outcome (audit trail). Records whether the
        // (subject, kind) skill pack was loaded for the check and the verdict.
        ...(tierChecks.includes('kind_conformance')
          ? {
              kind_conformance: {
                skill_loaded: verifySkillDocs !== undefined,
                verdict: parsed.kind_conformance?.verdict ?? null,
              },
            }
          : {}),
        // solve_check authoritative audit block (verdict + which axis
        // compared + the independent solver's answer + the human-readable reason). Keyed
        // on `solveResult` (undefined when short-circuited), NOT tierChecks.includes (which
        // is always true for this handler). additive JSONB, zero DDL. NOTE (Lens B m8): no
        // new event action (cardinality unchanged) so the memory-outbox poller predicate
        // (triggers.ts WHERE ingest_at IS NULL) is unaffected; solve_check.reason text
        // could reference solver/reference answers and would flow into any future memory
        // embedding of this event (additive, low risk).
        ...(solveResult
          ? {
              solve_check: {
                verdict: solveResult.verdict,
                compared_by: solveResult.compared_by,
                solver_final_answer: solveResult.solver_final_answer ?? null,
                reason: solveResult.reason,
                // the solve legs' own spend (the event-level
                // cost_micro_usd column covers only the QuizVerifyTask call): run ids in
                // call order + summed cost when the runner reported them.
                task_run_ids: solveResult.task_run_ids ?? null,
                cost_usd: solveResult.cost_usd ?? null,
              },
            }
          : {}),
        // teaching_quality authoritative audit block: overall verdict +
        // the three per-axis verdicts/reasons (clarity / unique_answer / distractor_power; the
        // last is 'skipped' for non-choice) + the审题闸's own run-id/cost. Keyed on
        // `teachingResult` (undefined when short-circuited). additive JSONB, zero DDL — mirrors
        // the solve_check block. No new event action (cardinality unchanged).
        ...(teachingResult
          ? {
              teaching_quality: {
                verdict: teachingResult.verdict,
                clarity: teachingResult.clarity,
                unique_answer: teachingResult.unique_answer,
                distractor_power: teachingResult.distractor_power,
                reason: teachingResult.reason,
                task_run_ids: teachingResult.task_run_ids ?? null,
                cost_usd: teachingResult.cost_usd ?? null,
              },
            }
          : {}),
        promoted: promote,
        verification_status: verificationStatus,
        // C1 绑定准入命中：成功分支未重发/未降级 admitted（不把行
        // 归一 base 重铸到 resolved revision）；失败分支仅当准入决定确证晚于
        // 本投递开工（generation > 开工快照）才跳过折叠/挂起。只记保留的
        // revision id，不记任何原文内容。
        ...(keptIndependentAdmissionRevisionId != null
          ? {
              admission: 'kept_independent_admission',
              kept_revision_id: keptIndependentAdmissionRevisionId,
            }
          : {}),
        ...(promotedAdmissionGeneration != null
          ? { admission_generation: promotedAdmissionGeneration }
          : {}),
        // overall / failure_class / summary_md / confidence now come from
        // `...unified` above (the unified verify contract shape). failure_class is keyed
        // there only when !promote (validation_failure), identical to the prior inline.
        verified_by: verifiedBy,
        ...(difficultyEvidence ? { difficulty_evidence: difficultyEvidence } : {}),
        ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
      },
      caused_by_event_id: null,
      task_run_id: taskRunId,
      cost_micro_usd: costMicroUsd,
      created_at: now,
    });
  });
}

interface RecordQuizVerifySystemFailureInput {
  db: Db;
  questionId: string;
  meta: QuizGenMetadataT;
  metadataRaw: Record<string, unknown>;
  err: unknown;
  taskResult: TaskTextResult | null;
  costMicroUsd: number | null;
  difficultyEvidence: unknown;
  supplyTrace: SupplyTraceV1T | undefined;
}

export async function recordQuizVerifySystemFailure(
  input: RecordQuizVerifySystemFailureInput,
): Promise<void> {
  const {
    db,
    questionId,
    meta,
    metadataRaw,
    err,
    taskResult,
    costMicroUsd,
    difficultyEvidence,
    supplyTrace,
  } = input;

  const failedTaskResult = taskResult as TaskTextResult | null;
  const failedVerification: QuizGenVerificationT = {
    status: 'failed',
    summary: `quiz_verify failed: ${String((err as Error).message ?? err)}`,
    verified_by: { by: 'ai', task_kind: 'QuizVerifyTask' },
  };
  const failedMeta: QuizGenMetadataT = { ...meta, verification: failedVerification };
  await db
    .update(question)
    .set({
      metadata: { ...metadataRaw, quiz_gen: failedMeta } as never,
      updated_at: new Date(),
    })
    .where(eq(question.id, questionId));
  await writeEvent(db, {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'quiz_verify',
    action: 'experimental:quiz_verify',
    subject_kind: 'question',
    subject_id: questionId,
    // 'error' (NOT 'failure') marks a TRANSIENT, non-terminal failure: the task
    // threw before producing a verdict. The idempotency guard treats this as
    // retriable (outcome != 'error'), so pg-boss redelivery re-runs the verify
    // instead of skipping it as already_verified. A terminal LLM verdict of
    // overall='fail' uses outcome='failure' on the success path above.
    outcome: 'error',
    payload: {
      question_id: questionId,
      // unified verify contract shape via the system_error
      // projection: { axes:[], overall:'error', failure_class:'system_error',
      // summary_md, confidence:0 }. This is the ONLY place the result-layer 'error'
      // value is ever written: the model can never emit it (LLM parse enum is 3-value),
      // so an `overall:'error'` payload is an unambiguous "system blew up before a
      // verdict" signal. The catch path NEVER promotes (it re-throws), so this can
      // never coincide with a promotion. `overall`/`failure_class` are byte-identical
      // to the prior inline values; axes/summary_md/confidence are additive (and this
      // outcome='error' event is filtered out by every downstream consumer anyway).
      ...toUnifiedVerifyResult({
        source: 'system_error',
        summary_md: `quiz_verify failed: ${String((err as Error).message ?? err)}`,
        error: String((err as Error).message ?? err),
      }),
      error: String((err as Error).message ?? err),
      // QoL（2026-09-13 判官解析失败不可诊断的教训）——parse 失败时把原始 LLM 输出头
      // 留在事件里：digest 只能证「跑过」，raw head 才能区分 refusal / 空响应 / 散文输出。
      // 截 500 字符防爆 payload；taskResult 为 null（SDK 层即抛）时留 null。
      raw_output_head: failedTaskResult?.text?.slice(0, 500) ?? null,
      ...(difficultyEvidence ? { difficulty_evidence: difficultyEvidence } : {}),
      ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
    },
    caused_by_event_id: null,
    task_run_id: failedTaskResult?.task_run_id ?? null,
    cost_micro_usd: costMicroUsd,
    created_at: new Date(),
  });
}
