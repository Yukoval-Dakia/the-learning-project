// tier-2 source_verify handler.
//
// Chained behind sourcing (the sourcing handler sends `source_verify`
// { question_ids } after writing draft questions, mirroring quiz_gen → quiz_verify).
// For each draft web_sourced question this handler runs the TIER-2 check set defined
// in verify-framework.ts (CHECK_SETS_BY_TIER[2] = structure_completeness +
// source_consistency + solve_check + dedup) and gates Option B:
//   pass (every check passes)   → promote draft_status 'draft'→'active' + FSRS enroll
//                                  (the question enters the review pool).
//   fail                        → leave draft_status='draft' (never reaches the pool).
//
// Skeleton copied from quiz_verify.ts (claim → idempotency → run → persist →
// writeEvent → catch). The checks here are mostly DETERMINISTIC (structure / source
// consistency / dedup); only solve_check spends an LLM call (reusing
// SolutionGenerateTask as an independent solver via verify-framework's runSolveCheck).
//
// tier2 vetoes EVERY solve_check fail (including normalize) BY DESIGN,
// unlike tier3/4's per-axis split in quiz_verify.ts: tier2 references are anchored on real web
// extracts, tier3/4's are same-model self-authored. See the solveCheckBlocks docblock in
// verify-framework.ts for the full asymmetry rationale before "unifying" the two.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { type TaskTextResult, aiAgentRef } from '@/ai/task-result';
import {
  type RunSourceGroundingVerifyParams,
  type SourceGroundingVerifyResult,
  runSourceGroundingVerify,
} from '@/capabilities/practice/server/judge/source-grounding-verify';
import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import { QUESTION_ADMISSION_POLICY_IDS } from '@/core/question-admission-policy';
import {
  LEGACY_DRAFT_STATUS,
  QUESTION_AVAILABILITY,
  SCORING_ADMISSION_STATE,
  SCORING_ADMISSION_WITHHELD_REASON,
  SUSPENSION_REASON,
} from '@/core/schema/assessment/lifecycle';
import { defaultPresentation } from '@/core/schema/assessment/presentation';
import { readDifficultyEvidenceFromMetadata } from '@/core/schema/difficulty-evidence';
import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectIntent,
  claimPaidEffectSend,
  markPaidEffectUnknown,
  recordPaidEffectApplication,
  recordPaidEffectResult,
} from '@/db/paid-effect-store';
import {
  event,
  knowledge,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  normalizeQuestionRowToContract,
  publishedContractSeal,
  publishedSealAccepts,
} from '@/kernel/records/assessment-normalization';
import {
  type AdmissionVerificationWrite,
  type PublishAdmission,
  type PublishQuestionGroupResult,
  type SuspensionUpdate,
  archiveGroupLifecycle,
  loadQuestionGroupContractSnapshot,
  promoteVerifiedGroupPartRows,
  publishQuestionGroup,
  publishQuestionGroupFromRow,
} from '@/kernel/records/assessment-publication';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { resolveQuestionAdmissionPolicyId } from '../server/admission/run-admission';
import { enrollPromotedQuestionScheduling } from '../server/question-scheduling-enrollment';
import { SupplyTraceV1 } from '../server/question-supply/evidence-demand';
import { readVectorNearHold, visibleSourceNeighbor } from '../server/question-supply/ingest-dedup';
import { lockPlacementSupplyScopes } from '../server/question-supply/placement-supply-lock';
import { DEDUP_OVERLAP_THRESHOLD } from '../server/question-supply/sourced-dedup';
import {
  type SolveCheckImageFetchFn,
  type SolveCheckQuestion,
  checksForTier,
  runSolveCheck,
} from '../server/quiz/verify-framework';
// revision→flat 投影原语经同 capability 工具文件
// 再出口（它对 questions seam 的 import 边已登记），本文件不新增
// capability→server 债。
import {
  deriveKind,
  draftCanonicalIdentity,
  revisionToDraftDocument,
} from '../server/tools/submit-question';
import { checkDedup } from './source_verify_dedup';
import {
  type CheckOutcome,
  checkSourceConsistency,
  checkStructureCompleteness,
} from './source_verify_prechecks';
import { projectSourceVerifyResult, solveCheckToOutcome } from './source_verify_result';

export interface SourceVerifyJobData {
  question_ids: string[];
  /**
   * owner-initiated recheck (POST .../serving-actions/recheck_source).
   * The command event id bypasses the terminal-event idempotency guard ONLY
   * for this command: at most one paid run per command event, because the
   * guard short-circuits once a terminal event carries the same
   * recheck_command_event_id.
   */
  recheck?: { command_event_id: string };
}

// Loose run seam (mirrors quiz_verify): the handler + solve-check only consume
// { text, task_run_id?, cost_usd? }. DB tests inject a vi.fn() returning a JSON
// string; production resolves runTask lazily.
export type RunTaskFn = TaskTextRunFn;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

// 阈值本体下沉到 server/question-supply/sourced-dedup.ts；此处 re-export
// 保既有 import 路径。near-duplicate 判定仍用同一 maxNgramOverlap（word-shingle
// Jaccard, CJK-aware）。
export { DEDUP_OVERLAP_THRESHOLD };

export type SourceVerifyPerQuestionStatus =
  | 'verified'
  | 'failed'
  | 'skipped:not_found'
  | 'skipped:not_web_sourced'
  | 'skipped:already_verified'
  /** a recheck whose durable paid-attempt claim is 'sending' or
   * 'unknown' (a prior delivery reached the paid call and never committed an
   * outcome). Never re-paid; the job completes, the hold stays visible. */
  | 'skipped:claim_held';

export interface RunSourceVerifyParams {
  db: Db;
  questionId: string;
  /** Executes solve/semantic checks and the default source-grounding task. */
  runTaskFn: RunTaskFn;
  imageFetchFn?: SolveCheckImageFetchFn;
  // source-grounding re-check seam (single_source_grounding rows only). DB tests
  // inject a stub to drive grounded / not_grounded / transient without real R2 / VLM spend;
  // An explicit override receives only SourceGroundingParams and takes precedence.
  // Otherwise runSourceGroundingVerify uses the same runTaskFn for SourceGroundingVerifyTask.
  sourceGroundingFn?: SourceGroundingFn;
  /**
   * owner recheck command id. When set, the terminal-event guard
   * below only short-circuits a terminal event that carries THIS id (a
   * redelivered/replayed command never pays twice); the first run for this
   * command proceeds past prior terminal events, and the new terminal event
   * supersedes them for downstream projections (latest wins).
   */
  recheckCommandEventId?: string;
  /**
   * the pg-boss job id that owns this recheck delivery. Becomes the
   * paid-effect claim's deliveryId: a crash after the paid call but before the
   * terminal event leaves the claim in 'sending'/'unknown', and a redelivery
   * under ANY job id is refused — one paid attempt per command event, never two.
   */
  recheckDeliveryId?: string;
}

export interface RunSourceVerifyResult {
  status: SourceVerifyPerQuestionStatus;
  checks?: CheckOutcome[];
}

/**
 * verify/promote 生命周期维度更新（admission / suspension / verification / availability），
 * 不携内容变更。
 *
 * 权威选择：凡组当前有【已发布 revision】，该冻结四层契约就是唯一
 * 内容权威——typed 候选（含不携 answer_shape/blank_order 的普通 parts）
 * 的 5 分/规则/unit 身份/points 不在 flat 行投影里，FromRow 重建会丢；
 * 对 row-归一发布的旧组，冻结层与行归一产物在 converged-writer 不变量下
 * 本就 digest 相同（生命周期更新更不该借机重铸内容 revision）。
 * 只有【从未发布】的真 legacy 组（current_revision_id 为空）走 FromRow。
 *
 * 核验输入绑定：expectedRevision / expectedGeneration 是调用方在
 * 核验【开始时】冻结的「被验证对象」身份（当时的组 current revision +
 *  admission generation）。本 helper 锁后比对——漂移即抛错回滚同事务，
 * 绝不把旧核验结果贴到较新 revision / 误清较新屏障。
 *
 * 锁序与既有约定一致：root question FOR UPDATE → lifecycle FOR UPDATE
 * → 发布（publisher 内部 CAS 双令牌另作纵深）。CAS 冲突或任何发布冲突
 * 一律抛错回滚（与 publishQuestionGroupFromRow 的 fail-closed 同款纪律）。
 *
 * 来源核验通过只改 admission/suspension/verification 维度——不授予 K1
 * admitted，不放宽中央保护（admitted + 声明仍过 publishQuestionGroup 的
 * 判分就绪闸）。
 */
export async function publishVerifyLifecycleUpdate(
  tx: Tx,
  input: {
    rootId: string;
    admission: PublishAdmission;
    availability?: 'general_pool' | 'container_only';
    suspension?: SuspensionUpdate;
    verification?: AdmissionVerificationWrite;
    /** 核验开始时冻结的组 current revision（null = 当时从未发布）。 */
    expectedRevision: string | null;
    /** 核验开始时冻结的 scoring_admission_generation。 */
    expectedGeneration: number | null;
    actorRef: string;
    now: Date;
  },
): Promise<PublishQuestionGroupResult> {
  const [supplied] = await tx
    .select({ id: question.id, parentId: question.parent_question_id })
    .from(question)
    .where(eq(question.id, input.rootId))
    .limit(1);
  if (supplied == null) {
    throw new Error(`publishVerifyLifecycleUpdate: root question '${input.rootId}' not found`);
  }
  const groupRootId = supplied.parentId ?? supplied.id;
  // 唯一加载口（锁序 root FOR UPDATE → 组快照）：partRows/liveParts 的
  // tombstone 判定语义不在这里复制；declared revision 不可解析仍 fail-loud。
  const snapshot = await loadQuestionGroupContractSnapshot(tx, groupRootId);
  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupRootId))
    .for('update')
    .limit(1);
  const currentRevisionId = lifecycle?.current_revision_id ?? null;
  const currentGeneration = lifecycle?.scoring_admission_generation ?? null;
  // F2 漂移闸：核验结果只许落在它被算出的那个 revision/generation 上。
  // （编辑 withheld→withheld 叠新 revision 不翻 question.version，行版本
  // 检查兜不住——这里按 revision/generation 身份兜底，漂移则整笔回滚。）
  if (
    currentRevisionId !== input.expectedRevision ||
    currentGeneration !== input.expectedGeneration
  ) {
    throw new Error(
      `publishVerifyLifecycleUpdate: verify input drifted for group '${groupRootId}' ` +
        `(expected revision ${input.expectedRevision ?? 'none'}/gen ${input.expectedGeneration ?? 'none'}, ` +
        `now ${currentRevisionId ?? 'none'}/${currentGeneration ?? 'none'}) — refusing to apply a stale verify verdict`,
    );
  }
  // 全部子 part 已 tombstone ⇒ 组无可服务成员：与 FromRow 同款的撤回语义
  // （只落 lifecycle 撤回维度，不铸空组 revision、忽略传入生命周期字段）。
  // declared 组不能进 FromRow（声明保护在归一前先冲突）→ 此处直接落。
  if (snapshot.partRows.length > 0 && snapshot.liveParts.length === 0) {
    await archiveGroupLifecycle(tx, groupRootId, input.now);
    return { status: 'withdrawn', group_id: groupRootId };
  }
  if (currentRevisionId == null) {
    // 真 legacy：组从未发布（无冻结 revision 可保），行归一发布照旧。
    return publishQuestionGroupFromRow(tx, {
      rootId: groupRootId,
      admission: input.admission,
      ...(input.availability != null ? { availability: input.availability } : {}),
      ...(input.suspension != null ? { suspension: input.suspension } : {}),
      ...(input.verification != null ? { verification: input.verification } : {}),
      actorRef: input.actorRef,
      now: input.now,
    });
  }
  const [frozenRevision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, currentRevisionId))
    .limit(1);
  if (frozenRevision == null) {
    throw new Error(
      `publishVerifyLifecycleUpdate: current revision '${currentRevisionId}' missing for group '${groupRootId}'`,
    );
  }
  const [rootRow] = await tx
    .select({ source: question.source })
    .from(question)
    .where(eq(question.id, groupRootId))
    .limit(1);
  const result = await publishQuestionGroup(tx, {
    group_id: groupRootId,
    readAssetBytes: async (storageKey) => {
      const { getR2 } = await import('@/server/r2');
      return getR2().get(storageKey);
    },
    contract: {
      // F1：冻结四层（含 presentation/digest）逐字回送——同 digest ⇒ 不铸
      // 新 revision；声明与非声明的 typed 契约都被字节级保留。
      structure: frozenRevision.structure,
      response_spec: frozenRevision.response_spec,
      scoring_basis: frozenRevision.scoring_basis,
      execution_plan: frozenRevision.execution_plan,
      ...(frozenRevision.presentation != null ? { presentation: frozenRevision.presentation } : {}),
      integrity_digest: frozenRevision.integrity_digest,
    },
    expectedCurrentRevision: currentRevisionId,
    expectedAdmissionGeneration: currentGeneration,
    availability:
      input.availability ??
      lifecycle?.availability ??
      (rootRow?.source === 'web_sourced' || rootRow?.source === 'quiz_gen'
        ? QUESTION_AVAILABILITY.GENERAL_POOL
        : QUESTION_AVAILABILITY.CONTAINER_ONLY),
    admission: input.admission,
    ...(input.suspension != null ? { suspension: input.suspension } : {}),
    ...(input.verification != null ? { verification: input.verification } : {}),
    actorRef: input.actorRef,
    now: input.now,
  });
  if (result.status === 'conflict') {
    throw new Error(
      `publishVerifyLifecycleUpdate: unexpected ${result.reason} conflict for group '${groupRootId}' (revision raced during verify lifecycle update)`,
    );
  }
  return result;
}

// ---------- deterministic checks ----------
//
// the two PURE pre-checks of this set (structure_completeness +
// source_consistency, with the CheckOutcome record) moved to
// ./source_verify_prechecks.ts. What remains here is the checks that cannot
// be pure: dedup queries the pool and solve_check spends the LLM call.

type QuestionRow = typeof question.$inferSelect;

// ---------- source-grounding gate (single_source_grounding rows) ----------
//
// image_candidate accept (src/capabilities/ingestion/server/image-candidate-accept.ts)
// materializes a web_sourced draft whose deterministic `source_consistency` n-gram check
// is GROUNDING-AGAINST-SELF: the stored `extract` is the SAME single VLM call's own
// output, so the overlap passes (near-)trivially. Those rows carry
// metadata.single_source_grounding=true + the source image's asset id
// (metadata.image_candidate_source_asset_id). For them source_verify runs ONE paid
// vision re-check — re-read the source image + ask「题面是否真在图里」 — via the dedicated
// SourceGroundingVerifyTask (runSourceGroundingVerify). This is a GROUNDING-presence
// check, NOT answer judging: the earlier draft fed reference_md as a "student answer" to
// the multimodal_direct answer judge, which could not catch a VLM that hallucinated a
// self-consistent 题面 + 答案 unrelated to the image.
//
// Owner 2026-07-23 决策清单② — accept = 授权自动复核一次; 复核失败 = 打回 draft（不入池）.
//
// Semantics matrix (runSourceGroundingVerify → SourceGroundingVerifyResult.status):
//   'not_grounded'    → 题面 not in the source image → grounding FAIL → demote to draft
//   'grounded'        → grounding PASS
//   'transient_error' → image fetch / LLM call / output parse failed — NOT a content
//     verdict. FAIL-CLOSED: demote the (pre-promoted active) single-source row to draft
//     FIRST, then throw so the catch-bottom writes a retriable outcome='error' event and
//     pg-boss re-runs (既有 verify 错误惯例); a later 'grounded' re-check re-promotes it.
//     Without the fail-closed demote the row would stay pool-selectable during the retry
//     window, bypassing this gate. It is NEVER conflated with
//     「题面不在图里」. The demote is scoped to THIS single-source row only.
//
// The runner's runTask writes its own ai_task_runs + cost_ledger row (real spend,
// auditable); the verify event records the verdict + triggered_by='image_candidate_accept'
// (the accept-authorization extension).

// Fix-forward #1063 (PRRT…TotCQ) — derive the seam's params from the runner's own
// param interface (minus the runner-internal injectable seams) instead of re-declaring
// the core fields. runSourceGroundingVerify (whose extra params are optional) stays
// assignable to SourceGroundingFn.
export type SourceGroundingParams = Omit<
  RunSourceGroundingVerifyParams,
  'runTaskFn' | 'imageFetchFn'
>;
export type SourceGroundingFn = (
  params: SourceGroundingParams,
) => Promise<SourceGroundingVerifyResult>;

/**
 * Verify a single sourced draft question against the tier-2 check set. Idempotent
 * per (question_id) via the chained verify event guard. Promotes draft→active +
 * FSRS-enrolls when there is no hard fail or unresolved anchored exact mismatch.
 */
export async function runSourceVerify(
  params: RunSourceVerifyParams,
): Promise<RunSourceVerifyResult> {
  const { db, questionId, runTaskFn } = params;

  // 核验输入与身份必须同一快照：
  // 行内容 + 组 current revision/generation + 对应冻结 revision 行在【同一
  // 条 SELECT】内读出（单语句一致性；不持锁跨付费调用）。分开读会拼出
  // 「旧行内容 + 新 revision 身份」——withheld→withheld 编辑铸新 revision
  // 不动 question 行，检查却在核旧投影、结论又贴新身份。
  const [snap] = await db
    .select({
      row: question,
      lifecycleRevisionId: question_group_lifecycle.current_revision_id,
      admissionGeneration: question_group_lifecycle.scoring_admission_generation,
      frozenRevision: question_revision,
    })
    .from(question)
    .leftJoin(
      question_group_lifecycle,
      sql`${question_group_lifecycle.group_id} = coalesce(${question.parent_question_id}, ${question.id})`,
    )
    .leftJoin(
      question_revision,
      sql`${question_revision.revision_id} = ${question_group_lifecycle.current_revision_id}`,
    )
    .where(eq(question.id, questionId))
    .limit(1);
  const row = snap?.row;
  if (!row) return { status: 'skipped:not_found' };
  if (row.source !== 'web_sourced') return { status: 'skipped:not_web_sourced' };
  // 核验输入身份 = 快照里的组 current revision + admission generation；
  // 应用侧（publishVerifyLifecycleUpdate / 主事务漂移闸）锁后比对，漂移回滚。
  const verifiedIdentity = {
    revisionId: snap.lifecycleRevisionId ?? null,
    admissionGeneration: snap.admissionGeneration ?? null,
  };
  const frozenRevision =
    verifiedIdentity.revisionId != null &&
    snap.frozenRevision != null &&
    snap.frozenRevision.revision_id === verifiedIdentity.revisionId
      ? snap.frozenRevision
      : null;
  if (verifiedIdentity.revisionId != null && frozenRevision == null) {
    // lifecycle 指向的 revision 行不存在 = 组指针损坏——响铃，不猜内容。
    throw new Error(
      `source_verify: lifecycle current revision '${verifiedIdentity.revisionId}' missing for question ${questionId}`,
    );
  }
  // 冻结契约是内容权威。legacy 行仅在现成发布 normalizer 能重建同一
  // integrity digest 时复用；否则只能消费可无损表达的冻结投影。
  // provenance/KC/plumbing 留在行上，不能因此继承行级答案权威。
  let verifyInput: QuestionRow = row;
  /** flat 投影对核验有损 ⇒ 付费前明确 hold（原因，见下方 gate）。 */
  let verifyInputHoldReason: string | null = null;
  const frozenFigures =
    frozenRevision?.structure.materials.filter((m) => m.kind === 'figure') ?? [];
  // 复用冻结资产 digest 只为重建发布时的归一输入，不查询/冒充新资产核验。
  const figureDigests = Object.fromEntries(
    frozenFigures.flatMap((m) =>
      /^sha256:[a-f0-9]{64}$/i.test(m.asset.digest)
        ? [[m.asset.asset_id, m.asset.digest.slice('sha256:'.length)]]
        : [],
    ),
  );
  let legacyRowMatchesRevision = false;
  let presentationProjectsLosslessly = frozenRevision?.presentation == null;
  if (frozenRevision != null) {
    if (frozenRevision.presentation != null) {
      const standard = defaultPresentation(
        frozenRevision.structure,
        frozenRevision.response_spec,
        frozenRevision.scoring_basis,
      );
      // 只接受现役 producer 的标准呈现：题干 part_ref + 普通选项/空/作答区。
      // 默认生成器也能输出 matching/order/break_tap；flat choices 不表达它们。
      // canonical seal 消除 jsonb 键序差异，仍逐字段约束内容引用和作答绑定；
      // custom、material_ref、增删题干/输入或改绑都不可能与标准树同封存。
      presentationProjectsLosslessly =
        standard?.root.kind === 'stack' &&
        standard.root.children.every((block) =>
          ['text_math', 'option_list', 'blank_input', 'free_area'].includes(block.kind),
        ) &&
        publishedContractSeal(frozenRevision).canonical ===
          publishedContractSeal({ ...frozenRevision, presentation: standard }).canonical;
    }
    try {
      // 先验证库存 digest 确实封存这份冻结内容（兼容合法旧键序 seal），
      // 再按 canonical 内容比较；既不把旧 seal 恒判漂移，也不接受坏 seal。
      const frozenSeal = publishedContractSeal(frozenRevision);
      legacyRowMatchesRevision =
        publishedSealAccepts(frozenSeal, frozenRevision.integrity_digest) &&
        publishedContractSeal(normalizeQuestionRowToContract({ ...row, figureDigests }))
          .canonical === frozenSeal.canonical &&
        // structured normalizer 可优先用叶答案/选项，忽略 flat 列。
        // 复用 flat verifier 前，额外证明它实际读取的答案/选项也已封存。
        (row.structured == null ||
          ((row.reference_md == null ||
            frozenRevision.structure.materials.some(
              (m) => m.caption === 'reference solution' && m.content_md === row.reference_md,
            )) &&
            ((row.choices_md?.length ?? 0) === 0 ||
              frozenRevision.response_spec.slots.some(
                (s) =>
                  (s.kind === 'single_choice' || s.kind === 'multi_choice') &&
                  JSON.stringify(s.options.map((o) => o.text)) === JSON.stringify(row.choices_md),
              )))) &&
        // image_refs 不在 normalizer 输入内，不能让未封存的资产进入 solver。
        row.image_refs.every((id) => frozenFigures.some((m) => m.asset.asset_id === id));
    } catch {
      // 非 legacy / 无法归一不等于一致，继续冻结投影的付费前形状闸。
    }
  }
  if (frozenRevision != null && legacyRowMatchesRevision && presentationProjectsLosslessly) {
    // text/numeric/structured legacy 槽不用绕草稿编辑器的 free fallback。
    // reference、rubric、判分意图及材料由完整 digest 证明属于本 revision。
    // 资产来自冻结材料；行级 bbox/placement 未封存，不作 solver 提示。
    verifyInput = {
      ...row,
      image_refs: frozenFigures.map((m) => m.asset.asset_id),
      figures: [],
      structured: null,
    };
  } else if (frozenRevision != null) {
    const verifyDoc = revisionToDraftDocument(
      {
        revision_id: frozenRevision.revision_id,
        group_id: frozenRevision.group_id,
        structure: frozenRevision.structure,
        response_spec: frozenRevision.response_spec,
        scoring_basis: frozenRevision.scoring_basis,
        execution_plan: frozenRevision.execution_plan,
        presentation: frozenRevision.presentation,
      },
      // KC 归属是组/行级账本（claim merge 写行），不在 revision 层——
      // 快照内的行值即被验对象的 KC 集。
      { knowledge_ids: row.knowledge_ids ?? [] },
    );
    const verifyUnits = verifyDoc.parts.flatMap((part) => part.units);
    const selectUnits = verifyUnits.filter((u) => u.response_spec.kind === 'select');
    if (
      // flat 核验无法保留多 part/unit/slot 的作答边界。
      verifyDoc.parts.length !== 1 ||
      verifyUnits.length !== 1 ||
      frozenRevision.response_spec.slots.length !== 1
    ) {
      verifyInputHoldReason = 'typed_multiple_response_boundaries';
    } else if (
      // scoring unit 引用多 slot 时投影只取 slot_refs[0]，其余槽位不进视图。
      frozenRevision.scoring_basis.units.some((unit) => unit.slot_refs.length > 1)
    ) {
      verifyInputHoldReason = 'typed_multi_slot_scoring_unit';
    } else if (
      // draftSpecFromSlot 不可映射 → 该 unit 以 {kind:'free'} 兜底 +
      // metadata.unmapped_slot_kind 显式标记（投影器自身记号，非猜测）。
      verifyUnits.some(
        (u) => (u.metadata as Record<string, unknown> | undefined)?.unmapped_slot_kind != null,
      )
    ) {
      verifyInputHoldReason = 'typed_unmapped_slot_kind';
    } else if (selectUnits.length > 1) {
      // projectChoices 只取第一个 select unit —— 多 select 槽位喂给
      // 求解器是残缺选项集。
      verifyInputHoldReason = 'typed_multi_select_units';
    } else if (
      selectUnits.some((u) => {
        const spec = u.response_spec;
        return (
          spec.kind === 'select' &&
          u.key?.kind === 'select' &&
          u.key.accepted_item_ids.some(
            (itemId) => !spec.items.some((item) => item.item_id === itemId),
          )
        );
      })
    ) {
      // select 键引用了 spec.items 之外的 item_id —— projectReference 会
      // 静默丢该键，flat 视图的答案残缺。
      verifyInputHoldReason = 'typed_select_key_unresolved';
    } else if (
      // 已冻结的选择键可直接比较；私有旧 rubric/解析不能抢占它。
      // 标准展示只引用下面实际投影的题干/选项/槽；其他展示不可静默丢弃。
      !presentationProjectsLosslessly ||
      frozenRevision.structure.materials.some(
        (m) =>
          m.kind === 'figure' ||
          m.visibility !== 'private' ||
          (m.caption !== 'reference solution' &&
            m.caption !== 'rubric (authoritative scoring input)'),
      ) ||
      frozenRevision.scoring_basis.units.some(
        (u) =>
          u.material_refs.length > 0 ||
          u.evidence_slot_refs.length > 0 ||
          u.requires_group_evidence,
      ) ||
      frozenRevision.response_spec.slots.some(
        (s) => s.kind === 'open_response' && (s.evidence_required || s.accepted_evidence?.length),
      )
    ) {
      verifyInputHoldReason = 'typed_unprojected_material_or_evidence';
    } else if (
      // 非 key 型私有材料可能承载 rubric，不能当普通答案或静默舍弃。
      frozenRevision.structure.materials.length > 0 &&
      selectUnits.length === 0
    ) {
      verifyInputHoldReason = 'typed_unprojected_private_scoring_material';
    }
    const ident = draftCanonicalIdentity(verifyDoc);
    verifyInput = {
      ...row,
      kind: deriveKind(verifyDoc),
      prompt_md: ident.promptMd,
      reference_md: ident.referenceMd,
      choices_md: ident.choicesMd,
      judge_kind_override: null,
      rubric_json: null,
      structured: null,
      image_refs: [],
      figures: [],
    };
  }
  const metadataRaw =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  // supply_trace is best-effort provenance carried onto the verify event, not a
  // promotion input. A JSONB `null` (valid, distinct from absent) or a malformed
  // value must NOT throw here — this runs BEFORE the failure-bottom try, so a throw
  // would strand the draft with no error event and retry identically forever. Mirror
  // readDifficultyEvidenceFromMetadata: safeParse and drop on any failure.
  const supplyTraceResult = SupplyTraceV1.safeParse(metadataRaw.supply_trace);
  const supplyTrace = supplyTraceResult.success ? supplyTraceResult.data : undefined;
  const difficultyEvidence = readDifficultyEvidenceFromMetadata(metadataRaw);

  // Idempotency: only a TERMINAL verify event short-circuits a re-run (outcome !=
  // 'error'). The catch-bottom writes a TRANSIENT-error event with outcome='error'
  // so a one-off LLM/DB blowup doesn't strand the draft (mirrors quiz_verify).
  // an owner recheck bypasses prior terminal events but stays
  // claim-scoped: only a terminal event carrying THIS recheck_command_event_id
  // short-circuits, so a redelivered job / replayed key can never pay twice.
  const existingVerify = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:source_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        ne(event.outcome, 'error'),
        params.recheckCommandEventId != null
          ? sql`${event.payload}->>'recheck_command_event_id' = ${params.recheckCommandEventId}`
          : sql`true`,
      ),
    )
    .limit(1);
  if (existingVerify.length > 0) return { status: 'skipped:already_verified' };

  // recheck paid-attempt claim (P1-A): a DURABLE claim scoped to
  // the command event, taken BEFORE the paid verifier calls. The terminal-event
  // guard alone could not catch a crash between the paid call and the event
  // commit — the claim can: 'sending'/'unknown' is never re-paid, the job ends
  // honestly (hold stays, pending_action clears), and 'receipt_ready'/'applied'
  // means the run already completed.
  let recheckClaim: { identity: PaidEffectIdentity; fence: number; deliveryId: string } | null =
    null;
  if (params.recheckCommandEventId != null) {
    const commandEventId = params.recheckCommandEventId;
    const deliveryId = params.recheckDeliveryId ?? `manual:${commandEventId}`;
    const claimOutcome = await db.transaction(async (tx) => {
      const recheckEffect = {
        family: 'source_verify' as const,
        entityId: questionId,
        entityRevision: commandEventId,
        unit: 'source_verify@1' as const,
        input: { question_id: questionId, command_event_id: commandEventId },
      };
      const admitted = await admitPaidEffectIntent(tx, recheckEffect);
      if (admitted.kind === 'existing' && admitted.state !== 'pending') {
        return { kind: 'held' as const, state: admitted.state };
      }
      const identity = computePaidEffectIdentity(recheckEffect);
      const send = await claimPaidEffectSend(tx, identity, {
        backend: 'pg-boss',
        deliveryId,
        leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
      });
      if (send.kind !== 'claimed') {
        return { kind: 'held' as const, state: send.kind === 'refused' ? send.state : 'pending' };
      }
      return { kind: 'claimed' as const, identity, fence: send.fence };
    });
    if (claimOutcome.kind !== 'claimed') {
      // 'sending'/'unknown' — a prior delivery reached the paid call and its
      // outcome is genuinely unknown; never re-pay. The hold stays honest and
      // the job completes so pending_action clears.
      return { status: 'skipped:claim_held', checks: [] };
    }
    recheckClaim = { identity: claimOutcome.identity, fence: claimOutcome.fence, deliveryId };
  }

  // Resolve subject profile from the first knowledge node (same convention as
  // quiz_gen / quiz_verify).
  const firstKnowledgeId = row.knowledge_ids[0];
  const knowledgeRows = firstKnowledgeId
    ? await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, firstKnowledgeId))
        .limit(1)
    : [];
  const knowledgeNode = knowledgeRows[0] ?? null;
  const subjectProfile = resolveSubjectProfile(knowledgeNode?.domain ?? null);

  // knowledge survival re-check BEFORE promotion. A draft can sit
  // between sourcing and verify long enough for its knowledge point to be archived;
  // promoting it anyway enrolls FSRS cards onto a dead node (the same archived guard
  // sourcing.ts:resolveTrigger applies at INGEST time must also gate at PROMOTE time).
  // We re-query the row's knowledge_ids against live (archived_at IS NULL) nodes; if
  // ANY referenced knowledge point is archived (or no longer exists), the draft does
  // not promote and is not enrolled. The gate folds into the promote decision below
  // and is recorded on the verify event (knowledge_archived reason) rather than the
  // tier-2 checks[] array, which is typed to the formal VerifyCheck set.
  const referencedKnowledgeIds = Array.from(new Set(row.knowledge_ids ?? []));
  const liveKnowledgeRows = referencedKnowledgeIds.length
    ? await db
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(inArray(knowledge.id, referencedKnowledgeIds), isNull(knowledge.archived_at)))
    : [];
  const liveKnowledgeIds = new Set(liveKnowledgeRows.map((r) => r.id));
  const archivedKnowledgeIds = referencedKnowledgeIds.filter((id) => !liveKnowledgeIds.has(id));
  const knowledgeAlive = archivedKnowledgeIds.length === 0;

  try {
    // Run the tier-2 check set (CHECK_SETS_BY_TIER[2]). structure_completeness +
    // source_consistency + dedup are deterministic; solve_check spends the LLM call.
    const tierChecks = checksForTier(2);
    const checks: CheckOutcome[] = [];
    let unresolvedAnchoredExactMismatch = false;
    let imageInputUnavailable = false;

    // R1 F2 —— flat 投影对核验输入有损 ⇒ 付费前明确 hold：只落一条
    // structure_completeness fail（原因名指到具体有损形状），不跑确定性
    // 检查不花 solve/grounding——不走「拿残缺视图验一遍」的猜测路径。
    // fail → 既有 !promote 分支（demote + verify_hold suspend + 证据落账），
    // 后续编辑改形状后重验可恢复，typed sourcing 的真实可用面不受影响。
    if (verifyInputHoldReason != null) {
      checks.push({
        check: 'structure_completeness',
        verdict: 'fail',
        reason: `frozen revision's flat projection is lossy for verification (${verifyInputHoldReason}); refusing to run checks against a partial view — hold until the shape projects losslessly or verify learns typed inputs`,
      });
    } else {
      if (tierChecks.includes('structure_completeness')) {
        checks.push(checkStructureCompleteness(verifyInput));
      }
      if (tierChecks.includes('source_consistency')) {
        checks.push(checkSourceConsistency(verifyInput));
      }
      if (tierChecks.includes('dedup')) {
        checks.push(await checkDedup(db, verifyInput));
      }
      if (tierChecks.includes('solve_check')) {
        const solveQuestion: SolveCheckQuestion = {
          id: verifyInput.id,
          kind: verifyInput.kind,
          prompt_md: verifyInput.prompt_md,
          reference_md: verifyInput.reference_md,
          choices_md: verifyInput.choices_md,
          judge_kind_override: verifyInput.judge_kind_override,
          rubric_json: verifyInput.rubric_json,
          knowledge_ids: verifyInput.knowledge_ids,
          // metadata 的来源/KC 账本可留给确定性检查；其中腾讯答案/解析
          // 提示不在冻结契约内，不能进入该 revision 的独立求解输入。
          metadata: frozenRevision == null ? verifyInput.metadata : null,
          image_refs: verifyInput.image_refs,
          figures: verifyInput.figures,
        };
        const solveResult = await runSolveCheck(solveQuestion, {
          runTaskFn,
          profile: { id: subjectProfile.id, full: subjectProfile },
          db,
          imageFetchFn: params.imageFetchFn,
        });
        unresolvedAnchoredExactMismatch =
          solveResult.verdict === 'unsupported' && solveResult.normalized_exact_mismatch === true;
        imageInputUnavailable = solveResult.image_input_unavailable === true;
        checks.push(solveCheckToOutcome(solveResult));
      }
    }

    // `otherwisePromotable` is the tier-2 promote decision BEFORE the source-grounding gate:
    // knowledge survived, no unresolved exact mismatch, image input available, no failing
    // check. It is the SINGLE source for both the grounding-gate trigger below AND the final
    // `promote` (which just ANDs in the grounding verdict) (was
    // two copy-pasted condition lists).
    const storedHold = readVectorNearHold(metadataRaw);
    const vectorNearHold =
      storedHold != null && (await visibleSourceNeighbor(db, storedHold.neighbor_question_id))
        ? storedHold
        : null;
    const otherwisePromotable =
      knowledgeAlive &&
      !unresolvedAnchoredExactMismatch &&
      !imageInputUnavailable &&
      !checks.some((c) => c.verdict === 'fail') &&
      vectorNearHold == null;

    // ---- source-grounding gate (single_source_grounding rows only) ----
    // Runs ONLY when the row is otherwise promotable: a deterministic/solve fail already
    // keeps it draft, so spending the paid vision re-check on a doomed draft is wasted. For
    // a single-source row this is the FINAL, real grounding gate — its source_consistency
    // n-gram is grounding-against-self (extract === the same VLM call's output). See the
    // SourceGroundingParams docblock for the full semantics matrix.
    const singleSourceGrounding = metadataRaw.single_source_grounding === true;
    const groundingSourceAssetId =
      typeof metadataRaw.image_candidate_source_asset_id === 'string'
        ? metadataRaw.image_candidate_source_asset_id
        : null;
    let multimodalGroundingFailed = false;
    let groundingRan = false;
    let groundingSummary: string | undefined;
    let groundingConfidence: number | undefined;
    // Defense-in-depth (fix-forward #1063 PRRT…TotCO): a row that CLAIMS
    // single_source_grounding but carries NO image_candidate_source_asset_id cannot be
    // grounded — the previous `&& groundingSourceAssetId` gate silently SKIPPED such a row
    // and let it promote. Fail CLOSED instead: mark a source_grounding fail (→ overall=fail
    // → the pre-promoted row is demoted out of the pool) and log for diagnosis. Runs only
    // when otherwise-promotable (a row already failing another check needs no extra fail).
    if (singleSourceGrounding && otherwisePromotable && !groundingSourceAssetId) {
      console.warn(
        `[source_verify] ${questionId} is single_source_grounding but has no image_candidate_source_asset_id; failing grounding closed`,
      );
      groundingRan = true;
      multimodalGroundingFailed = true;
      groundingSummary =
        'single_source_grounding row is missing image_candidate_source_asset_id; grounding could not be verified';
      checks.push({ check: 'source_grounding', verdict: 'fail', reason: groundingSummary });
    }
    if (singleSourceGrounding && groundingSourceAssetId && otherwisePromotable) {
      const groundingFn = params.sourceGroundingFn;
      let outcome: SourceGroundingVerifyResult;
      try {
        const groundingParams: SourceGroundingParams = {
          db,
          prompt_md: verifyInput.prompt_md,
          reference_md: verifyInput.reference_md,
          sourceAssetId: groundingSourceAssetId,
          subjectProfile,
        };
        outcome = groundingFn
          ? await groundingFn(groundingParams)
          : await runSourceGroundingVerify({ ...groundingParams, runTaskFn });
      } catch (err) {
        // a BARE throw from the grounding fn (a bug, or a future
        // change that stops returning the discriminated result) must NOT bypass fail-closed.
        // Fold it into the SAME transient_error branch (demote → throw) as a returned
        // transient_error, so an unexpected throw can never silently leave a pre-promoted row
        // in the pool.
        outcome = {
          status: 'transient_error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (outcome.status === 'transient_error') {
        // Transient grounding is retriable, not a content verdict. Commit legacy draft
        // and contract suspended/withheld together before throwing to retry. Root→child
        // locks serialize with editing/publishing; re-read version and terminal success
        // under those locks so a stale delivery cannot undo a newer admission.
        // A failed suspension rolls back the demotion too; catch-bottom records an error.
        try {
          await db.transaction(async (suspendTx) => {
            const groupRootId = row.parent_question_id ?? questionId;
            await suspendTx
              .select({ id: question.id })
              .from(question)
              .where(eq(question.id, groupRootId))
              .for('update')
              .limit(1);
            const [post] = await suspendTx
              .select({
                version: question.version,
                promotedElsewhere: sql<boolean>`EXISTS (
                  SELECT 1 FROM ${event}
                  WHERE ${event.action} = 'experimental:source_verify'
                    AND ${event.subject_kind} = 'question'
                    AND ${event.subject_id} = ${questionId}
                    AND ${event.outcome} = 'success'
                )`,
              })
              .from(question)
              .where(eq(question.id, questionId))
              .for('update')
              .limit(1);
            const maySuspendContract =
              post != null && post.version === row.version && !post.promotedElsewhere;
            if (!maySuspendContract) return;
            await suspendTx
              .update(question)
              .set({ draft_status: LEGACY_DRAFT_STATUS.DRAFT, updated_at: new Date() })
              .where(eq(question.id, questionId));
            // 已声明 revision 走冻结契约的 typed lifecycle 更新，
            // 未声明组照旧行归一（helper 内部分派，fail-closed 不变）。
            await publishVerifyLifecycleUpdate(suspendTx, {
              rootId: groupRootId,
              expectedRevision: verifiedIdentity.revisionId,
              expectedGeneration: verifiedIdentity.admissionGeneration,
              admission: {
                state: SCORING_ADMISSION_STATE.WITHHELD,
                reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
              },
              suspension: { suspended: true, reason: SUSPENSION_REASON.VERIFY_HOLD },
              verification: {
                policy_id: 'source_verify@1',
                outcome: 'suspended',
                evidence: {
                  check: 'source_grounding',
                  transient: true,
                  message: outcome.message,
                },
              },
              actorRef: 'source_verify:suspend',
              now: new Date(),
            });
          });
        } catch (suspendErr) {
          console.error('[source_verify] verify-hold write failed for', questionId, suspendErr);
        }
        throw new Error(
          `source_verify source grounding failed (transient) for ${questionId}: ${outcome.message}`,
        );
      }
      groundingRan = true;
      groundingConfidence = outcome.confidence;
      groundingSummary = outcome.reason_md;
      multimodalGroundingFailed = outcome.status === 'not_grounded';
      // push the grounding verdict as a real check so
      // toUnifiedVerifyResult's roll-up sees a failing check and yields overall='fail'
      // (previously grounding fail lived only in `promote` + the summary, so a not_grounded
      // row projected overall='needs_review' while its summary said "failed" — a mismatch).
      checks.push({
        check: 'source_grounding',
        verdict: multimodalGroundingFailed ? 'fail' : 'pass',
        reason: outcome.reason_md,
      });
    }

    // Option B gate: ordinary unsupported remains non-blocking (R2), but when an
    // exact solver/reference mismatch survives because SemanticJudge was unavailable
    // or still disagreed below threshold, a web-sourced answer is not safe to auto-
    // promote. Keep it draft for review without relabelling the mismatch as a fail.
    // a single-source grounding FAIL (题面 not confirmed in the source image)
    // also blocks promotion → the !promote demote path returns the pre-promoted cold-start
    // draft to draft_status='draft' (not into the pool).
    const promote = otherwisePromotable && !multimodalGroundingFailed;

    // solve_check owns its AI run inside runSolveCheck, so this handler holds no
    // single TaskTextResult; the verify event carries the per-check verdicts as its
    // audit trail instead of a task_run_id.
    const now = new Date();
    const verifyEventId = createId();
    const verifiedBy = aiAgentRef('SourceVerify', { text: '' });

    // project the tier-2 per-check array onto the unified
    // verify contract shape. PROVABLY-EQUIVALENT: `promote` is passed IN (already decided
    // above as `knowledgeAlive && no failing check`); the helper only PROJECTS it and
    // ROLLS the per-check array up into an `overall` source-verify previously LACKED
    // (any failing check ⇒ fail, else promote ⇒ pass / not-promoted-without-fail ⇒
    // needs_review). The promote predicate is unchanged. The summary names the failing
    // check (or the knowledge-archived gate), giving draft-review.ts a驳回理由 it never
    // had for tier-2 drafts before. SUPERSET: the existing payload keys below are kept.
    // grounding fail is now a failing check in `checks[]`, so the generic
    // `failingCheck` branch names it (`source_grounding — <reason_md>`); no separate grounding
    // summary branch is needed, and toUnifiedVerifyResult's roll-up sees the failing check.
    const { failingCheck, unified } = projectSourceVerifyResult({
      checks,
      promote,
      unresolvedAnchoredExactMismatch,
      imageInputUnavailable,
      knowledgeAlive,
      vectorNearHold,
    });

    let wasDemoted = false;
    await db.transaction(async (tx) => {
      // global learning-state write lock FIRST (shared tx-entry order with every
      // material_fsrs_state / mastery_state writer and the cascade revert).
      await acquireLearningStateWriteLock(tx);
      // G→row lock order: acquire the placement supply scope lock BEFORE
      // the question row lock, matching placement paid admission (advisory lock → plain SELECT) and
      // proposal-appliers. The prior order (row lock first, supply lock only inside the promote
      // branch) let a concurrent /placement/start observe this draft as still-cold while this tx
      // waited on the advisory lock, then promote after paid work was enqueued — a double-supply
      // race. Locking row.knowledge_ids (pre-tx snapshot) is safe: on attribution drift the version
      // guard below throws and pg-boss reruns against the fresh scope.
      await lockPlacementSupplyScopes(tx, row.knowledge_ids ?? []);
      // Match editing/archive/publisher order even when this delivery targets a child.
      // Keep the global learning-write and placement-supply locks ahead of all row locks.
      if (row.parent_question_id != null) {
        await tx
          .select({ id: question.id })
          .from(question)
          .where(eq(question.id, row.parent_question_id))
          .for('update')
          .limit(1);
      }
      // The checks above ran against `row.version`. Cross-KC reconciliation bumps that version
      // under the same row lock; a mismatch makes this verdict stale, so abort before writing a
      // terminal event/promotion. The catch records a retriable outcome='error' and pg-boss reruns
      // against the current KC set. If this lock wins first, the later reconciler observes active
      // lifecycle and enrolls its added KC atomically.
      const [current] = await tx
        .select({
          version: question.version,
          knowledgeIds: question.knowledge_ids,
          draftStatus: question.draft_status,
          // As in the transient branch, a committed terminal success makes a failed
          // overlapping delivery stale: it must skip both demotion and suspension.
          promotedElsewhere: sql<boolean>`EXISTS (
            SELECT 1 FROM ${event}
            WHERE ${event.action} = 'experimental:source_verify'
              AND ${event.subject_kind} = 'question'
              AND ${event.subject_id} = ${questionId}
              AND ${event.outcome} = 'success'
          )`,
        })
        .from(question)
        .where(eq(question.id, questionId))
        .limit(1)
        .for('update');
      if (!current || current.version !== row.version) {
        throw new Error(
          `source_verify question ${questionId} changed during verification (expected version ${row.version}, got ${current?.version ?? 'missing'})`,
        );
      }
      // 锁后复核组身份（锁序 root question →
      // lifecycle 与 publisher/C1 一致）：行版本相同不代表 revision 未变
      // （withheld→withheld 草稿编辑不翻 version 仍铸新 revision）。与核验
      // 开始冻结值不符 ⇒ 整笔回滚：本次核验结果不得贴到较新 revision、
      // 不得误清其 verify_hold，也不得把 demote/suspend 落到没核过的版本上。
      const [verifyLifecycle] = await tx
        .select({
          revisionId: question_group_lifecycle.current_revision_id,
          generation: question_group_lifecycle.scoring_admission_generation,
        })
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, row.parent_question_id ?? questionId))
        .for('update')
        .limit(1);
      if (
        (verifyLifecycle?.revisionId ?? null) !== verifiedIdentity.revisionId ||
        (verifyLifecycle?.generation ?? null) !== verifiedIdentity.admissionGeneration
      ) {
        throw new Error(
          `source_verify: verify input drifted for question ${questionId} ` +
            `(expected revision ${verifiedIdentity.revisionId ?? 'none'}/gen ${verifiedIdentity.admissionGeneration ?? 'none'}, ` +
            `now ${verifyLifecycle?.revisionId ?? 'none'}/${verifyLifecycle?.generation ?? 'none'}) — refusing to apply a stale verify verdict`,
        );
      }
      // pair-race guard: promote 成功分支在重发前，同事务锁
      // question_group_lifecycle（FOR UPDATE，锁序 root question → lifecycle，
      // 与 publisher/C1 一致）读当前维度。三者同时成立时，这份 base 内容已被
      // question_admission_run 独立准入，本投递不得重发：
      //   1. lifecycle.scoring_admission_state === 'admitted'；
      //   2. 【当前 revision】上存在 policy question_admission@1 或 @2、outcome='passed'
      //      的 question_admission_verification 行（不匹配历史其他 revision 的
      //      passed 行）；
      //   3. 该行绑定当前已发布 revision 的 integrity_digest —— 权威绑定取
      //      publisher 写入的 revision_digest 列（resolved 发布后
      //      evidence.base_contract_digest 是付费【输入】摘要，不再等于发布
      //      摘要）；旧证据字段仅作 base==published 行的兼容回退
      //      （lifecycle.current_revision_id → question_revision.integrity_digest）。
      // 命中 ⇒ 不调 publishQuestionGroupFromRow：不把 admitted 降回 withheld，
      // 也不把行归一旧 base 重铸到 C1 的 resolved revision 上。其余情况（C1
      // 准入的是更老 base 后行又变了、他 policy 准入、未准入）保持 #1753 原行为。
      let keptIndependentAdmissionRevisionId: string | null = null;
      if (promote) {
        // Supply scope already locked at the top of this tx (G→row order above).
        await tx
          .update(question)
          .set({ draft_status: LEGACY_DRAFT_STATUS.ACTIVE, updated_at: now })
          .where(eq(question.id, questionId));

        await enrollPromotedQuestionScheduling(tx, {
          questionId,
          knowledgeIds: current.knowledgeIds ?? [],
          evidenceEventId: verifyEventId,
          now,
        });

        // 统一发布链：verified promote 同事务重发组 revision。
        // 来源核对通过 ≠ 判分准入。ADR-0073 四源同门：每个计分单元
        // 要两次独立解题一致 + 逐单元标定才 admitted，这里只有 tier-2 确定性
        // checks、没有独立核验，所以发布为 withheld(unverified_rules)＝待准入；
        // question_admission_run 经 assessment_publish outbox
        // 订阅自动入队，双解 + 标定通过后才 admitted。
        // 已发布过同内容的组在此只更新 admission 维度（generation+1）。
        // suspension:false 清 verify_hold（同版复核通过 ⇒ 幂等恢复，
        // 「同版复核通过」行）；retraction_hold 不由本路径接线，publisher 恒保留。
        const groupRootId = row.parent_question_id ?? questionId;

        // YUK-1568 S3 R1-F2 — 组拥有的声明子行晋升：typed 声明多 part 组的
        // question_part 子行（行 id = 冻结 revision structure.parts[].part_id
        // 绑定）随根核验成功同事务翻 ACTIVE + 继承证据留痕。锁序 root→child
        // （根行已在 tx 顶 FOR UPDATE）；旧式组与单 part 组命中零行 ⇒
        // no-op。子行不首发 active、无独立 paid verify；serving 门不变 ——
        // 仍需 part notDraft ∧ 组 admitted（C1 维度在下方发布链里翻）。
        const promotedPartRows =
          verifiedIdentity.revisionId != null
            ? await promoteVerifiedGroupPartRows(tx, {
                rootId: groupRootId,
                revisionId: verifiedIdentity.revisionId,
                verifyEventId,
                now,
              })
            : [];
        for (const part of promotedPartRows) {
          await enrollPromotedQuestionScheduling(tx, {
            questionId: part.id,
            knowledgeIds: part.knowledgeIds,
            evidenceEventId: verifyEventId,
            now,
          });
        }
        {
          const [lifecycle] = await tx
            .select()
            .from(question_group_lifecycle)
            .where(eq(question_group_lifecycle.group_id, groupRootId))
            .for('update')
            .limit(1);
          if (
            lifecycle != null &&
            lifecycle.scoring_admission_state === SCORING_ADMISSION_STATE.ADMITTED &&
            lifecycle.current_revision_id != null
          ) {
            const [c1Passed] = await tx
              .select({
                evidence: question_admission_verification.evidence,
                revisionDigest: question_admission_verification.revision_digest,
              })
              .from(question_admission_verification)
              .where(
                and(
                  eq(question_admission_verification.revision_id, lifecycle.current_revision_id),
                  inArray(question_admission_verification.policy_id, [
                    ...QUESTION_ADMISSION_POLICY_IDS,
                    resolveQuestionAdmissionPolicyId(),
                  ]),
                  eq(question_admission_verification.outcome, 'passed'),
                ),
              )
              .orderBy(desc(question_admission_verification.recorded_at))
              .limit(1);
            const recordedBaseDigest =
              c1Passed != null
                ? ((c1Passed.evidence as Record<string, unknown> | null)?.base_contract_digest ??
                  null)
                : null;
            if (c1Passed != null) {
              const [publishedRevision] = await tx
                .select({ integrity_digest: question_revision.integrity_digest })
                .from(question_revision)
                .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
                .limit(1);
              // after a resolved-contract publication the receipt's
              // evidence.base_contract_digest is the paid INPUT digest, not the
              // published digest. The authoritative binding is the row's own
              // revision_digest (publisher-written = the revision it verified);
              // the legacy base-contract match stays for rows whose verified
              // base IS the published document.
              const boundToCurrent =
                publishedRevision != null &&
                (c1Passed.revisionDigest === publishedRevision.integrity_digest ||
                  publishedRevision.integrity_digest === recordedBaseDigest);
              if (boundToCurrent) {
                keptIndependentAdmissionRevisionId = lifecycle.current_revision_id;
                // verify_hold 角：跳过发布会丢掉旧分支 suspension:{suspended:false}
                // 的清挂起效果。C1 admitted 的发布本已清 verify_hold；若此刻仍挂
                // verify_hold（跨 lane 再挂起），经 publisher 既有 dimension-only
                // 路径清除（digest 不变 ⇒ admission_updated，不铸新 revision），
                // admission 状态与证据原样保留（显式回传当前 admitted 维度）。
                if (
                  lifecycle.suspended === true &&
                  lifecycle.suspension_reason === SUSPENSION_REASON.VERIFY_HOLD
                ) {
                  const currentRevision = (
                    await tx
                      .select()
                      .from(question_revision)
                      .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
                      .limit(1)
                  )[0];
                  if (currentRevision == null) {
                    throw new Error(
                      `source_verify: current revision '${lifecycle.current_revision_id}' missing for group '${groupRootId}'`,
                    );
                  }
                  const cleared = await publishQuestionGroup(tx, {
                    group_id: groupRootId,
                    readAssetBytes: async (storageKey) => {
                      const { getR2 } = await import('@/server/r2');
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
                    expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
                    availability: lifecycle.availability,
                    admission: {
                      state: 'admitted',
                      evidence: lifecycle.scoring_admission_evidence ?? null,
                    },
                    suspension: { suspended: false },
                    verification: {
                      policy_id: 'source_verify@1',
                      outcome: 'passed',
                      evidence: {
                        checks: checks.map((c) => ({ check: c.check, verdict: c.verdict })),
                        demoted: false,
                        admission: 'kept_independent_admission',
                      },
                    },
                    actorRef: 'source_verify:promote',
                    now,
                  });
                  if (cleared.status === 'conflict') {
                    // 锁后读取 ⇒ 不该发生；出现即外部路径越过 seam 写 lifecycle ——
                    // fail-closed 回滚（同 FromRow 的 conflict 处理）。
                    throw new Error(
                      `source_verify: unexpected ${cleared.reason} conflict clearing verify_hold for group '${groupRootId}'`,
                    );
                  }
                }
              }
            }
          }
        }
        if (keptIndependentAdmissionRevisionId == null) {
          // 正向 promote 同样只翻生命周期维度；已声明 revision
          // 保留冻结契约（不铸新 revision、不丢声明、不因核验通过而 admitted）。
          await publishVerifyLifecycleUpdate(tx, {
            rootId: groupRootId,
            expectedRevision: verifiedIdentity.revisionId,
            expectedGeneration: verifiedIdentity.admissionGeneration,
            admission: {
              state: SCORING_ADMISSION_STATE.WITHHELD,
              reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
            },
            suspension: { suspended: false },
            verification: {
              policy_id: 'source_verify@1',
              outcome: 'passed',
              evidence: {
                checks: checks.map((c) => ({ check: c.check, verdict: c.verdict })),
                demoted: false,
              },
            },
            availability: QUESTION_AVAILABILITY.GENERAL_POOL,
            actorRef: 'source_verify:promote',
            now,
          });
        }
      } else {
        // ---- auto-promote one-way gate fix: demote a pre-promoted draft on FAIL. ----
        // The cold-start image-upload path (image-candidate-accept.ts) PRE-PROMOTES a
        // structurally-sound draft to draft_status='active' (no inbox wall) BEFORE this
        // source_verify runs, relying on source_verify as the deeper grounding gate. Until now
        // source_verify had only a PROMOTE branch, so a FAIL left such a question 'active' →
        // unverified content stayed placement-selectable (the "one-way gate"). Demote it back to
        // 'draft' so a failed-verify cold-start question leaves the pool.
        //
        // SCOPED-BY-CONSTRUCTION (no marker column needed): the ONLY question that can be 'active'
        // when source_verify reaches this !promote branch is a cold-start pre-promote (the same
        // image_candidate-accept path that also carries single_source_grounding — so a
        // grounding FAIL is one of the reasons a pre-promoted draft lands here). A normal
        // web_sourced draft (sourcing.ts) is 'draft' here → the WHERE draft_status='active' guard
        // makes the demote a no-op; an already-verified question is short-circuited by the
        // idempotency guard above (terminal verify event) and never reaches this branch;
        // verify-and-promote.ts gates draft_status='draft' before dispatching runSourceVerify. So
        // this UPDATE fires ONLY for the cold-start pre-promote case — a global no-op everywhere
        // else. No FSRS to clean: the pre-promote does not enroll FSRS (only the promote branch
        // above does, and it didn't run). draft_status='draft' is non-destructive pool-exclusion —
        // it stops FUTURE selection; any existing history is untouched. A later re-enqueue is
        // short-circuited by the failure verify event (idempotency), so the question stays out of
        // the pool until a human (verify-and-promote owner override) intervenes.
        // 并发终验成功（「旧验证不能改变较新 admission 决定」）⇒ 行已归
        // 那笔成功投递：demote 与 suspend 双双跳过（与 transient 分支同一
        // OVERLAPPING-DELIVERY 守卫，锁内读原子）。
        const promotedElsewhere = current.promotedElsewhere === true;
        const demotedRows = promotedElsewhere
          ? []
          : await tx
              .update(question)
              .set({ draft_status: LEGACY_DRAFT_STATUS.DRAFT, updated_at: now })
              .where(
                and(
                  eq(question.id, questionId),
                  eq(question.draft_status, LEGACY_DRAFT_STATUS.ACTIVE),
                  sql`NOT EXISTS (SELECT 1 FROM ${event} WHERE ${event.action} = 'experimental:source_verify' AND ${event.subject_kind} = 'question' AND ${event.subject_id} = ${questionId} AND ${event.outcome} = 'success')`,
                ),
              )
              .returning({ id: question.id });
        wasDemoted = demotedRows.length > 0;

        // verify 挂起串行化：非 promote 的 verify（失败或
        // needs_review）必须同事务把 contract 维度翻 suspended（verify_hold）+
        // admission 折叠 withheld ——「未发出的题」在 contract 读面不可用，且
        // 只挂 suspension，不动 live 去重 claim（挂起不释放 claim）。组未发布
        // 时 FromRow 直接铸 suspended 首版（同样 fail-closed）。
        // promotedElsewhere ⇒ 本投递 stale：不翻 contract 维度（honest：stale
        // 投递也不写核验记录 —— 记录的是「本版核验结果」，不该落在较新决定上）。
        if (!promotedElsewhere) {
          // hold/suspend 只翻生命周期维度；已声明 revision 走
          // 冻结契约的 typed publisher（helper 内部分派，fail-closed 不变）。
          await publishVerifyLifecycleUpdate(tx, {
            rootId: row.parent_question_id ?? questionId,
            expectedRevision: verifiedIdentity.revisionId,
            expectedGeneration: verifiedIdentity.admissionGeneration,
            admission: {
              state: SCORING_ADMISSION_STATE.WITHHELD,
              reason:
                failingCheck != null
                  ? SCORING_ADMISSION_WITHHELD_REASON.VERIFICATION_FAILED
                  : SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
            },
            suspension: { suspended: true, reason: SUSPENSION_REASON.VERIFY_HOLD },
            verification: {
              policy_id: 'source_verify@1',
              outcome: failingCheck != null ? 'failed' : 'suspended',
              evidence: {
                checks: checks.map((c) => ({ check: c.check, verdict: c.verdict })),
                demoted: wasDemoted,
              },
            },
            actorRef: 'source_verify:suspend',
            now,
          });
        }
      }

      // close the recheck paid-attempt claim IN THE SAME tx as the
      // terminal event + publish: a delivery that gets here is the one that
      // paid, and the claim reaching 'applied' is the durable proof no later
      // redelivery may re-pay.
      if (recheckClaim != null) {
        await recordPaidEffectResult(
          tx,
          recheckClaim.identity,
          recheckClaim.deliveryId,
          { status: promote ? 'verified' : 'failed', checks: checks.length },
          { fence: recheckClaim.fence },
        );
        await recordPaidEffectApplication(tx, recheckClaim.identity, {
          question_id: questionId,
          command_event_id: params.recheckCommandEventId,
          status: promote ? 'verified' : 'failed',
        });
      }

      await writeEvent(tx, {
        id: verifyEventId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: promote ? 'success' : 'failure',
        payload: {
          question_id: questionId,
          tier: 2,
          promoted: promote,
          // marks this terminal run as the paid attempt of an owner
          // recheck command; the terminal-event guard is claim-scoped on it.
          ...(params.recheckCommandEventId != null
            ? { recheck_command_event_id: params.recheckCommandEventId }
            : {}),
          // C1 先行独立准入命中：本次 success 未重发（未把 admitted
          // 降回 withheld，也未把行归一 base 重铸到 C1 的 resolved revision 上）。
          // 只记保留的 revision id，不记任何原文内容。
          ...(keptIndependentAdmissionRevisionId != null
            ? {
                admission: 'kept_independent_admission',
                kept_revision_id: keptIndependentAdmissionRevisionId,
              }
            : {}),
          // true when this FAIL demoted a cold-start pre-promoted draft
          // (draft_status active→draft); false on a normal draft FAIL (no-op) and on promote.
          demoted: wasDemoted,
          // unified verify contract shape (axes + overall +
          // failure_class? + summary_md + confidence). SUPERSET: the tier-2-specific keys
          // below (checks / knowledge_archived) stay unchanged. `unified.failure_class`
          // (validation_failure when !promote) reproduces the prior inline value
          // byte-identically; axes/overall/summary_md/confidence are additive — overall
          // fills the field source-verify previously lacked, giving draft-review.ts a
          // first-class verdict instead of inferring from outcome.
          ...unified,
          checks: checks.map((c) => ({ check: c.check, verdict: c.verdict, reason: c.reason })),
          // F3: record the knowledge-survival gate alongside the tier-2 checks. When a
          // referenced knowledge point was archived after sourcing, the draft is not
          // promoted/enrolled and this names the dead node(s) for the audit trail.
          ...(knowledgeAlive
            ? {}
            : {
                knowledge_archived: {
                  reason:
                    'referenced knowledge point archived after sourcing; not promoted/enrolled',
                  archived_knowledge_ids: archivedKnowledgeIds,
                },
              }),
          // the source-grounding re-check verdict (single_source_grounding rows
          // only; absent otherwise). triggered_by records the accept-authorization extension
          // (owner 2026-07-23 决策清单②). The real VLM cost is on the runner's own ai_task_runs
          // + cost_ledger row (SourceGroundingVerifyTask); this is the audit trail on the
          // verify event (mirrored by the source_grounding entry in checks[]).
          ...(groundingRan
            ? {
                source_grounding: {
                  grounded: !multimodalGroundingFailed,
                  ...(groundingConfidence !== undefined ? { confidence: groundingConfidence } : {}),
                  ...(groundingSummary ? { summary_md: groundingSummary } : {}),
                  source_asset_id: groundingSourceAssetId,
                  triggered_by: 'image_candidate_accept',
                },
              }
            : {}),
          verified_by: verifiedBy,
          ...(difficultyEvidence ? { difficulty_evidence: difficultyEvidence } : {}),
          ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
    });

    return { status: promote ? 'verified' : 'failed', checks };
  } catch (err) {
    // failure-bottom: write a TRANSIENT-error event so pg-boss redelivery re-runs the
    // verify (idempotency guard treats outcome='error' as retriable). A failed write
    // transaction preserves its prior state; the catch path never promotes.
    // error-safe: promotion happens only inside the try (post-LLM
    // gate), so reaching this catch guarantees the question was never promoted. The
    // unified system_error projection now ALSO gives tier-2 a symmetric result-layer
    // overall='error' (previously the handler emitted only failure_class); the
    // outcome='error' event is filtered out by every downstream consumer, so this is
    // purely additive. outcome + idempotency guard unchanged.
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: 'error',
        payload: {
          question_id: questionId,
          ...(params.recheckCommandEventId != null
            ? { recheck_command_event_id: params.recheckCommandEventId }
            : {}),
          // unified verify contract shape via the system_error
          // projection: { axes:[], overall:'error', failure_class:'system_error',
          // summary_md, confidence:0 }. failure_class is byte-identical to the prior
          // inline; overall/axes/summary_md/confidence are additive.
          ...toUnifiedVerifyResult({
            source: 'system_error',
            summary_md: `source_verify failed: ${String((err as Error).message ?? err)}`,
            error: String((err as Error).message ?? err),
          }),
          error: String((err as Error).message ?? err),
          ...(difficultyEvidence ? { difficulty_evidence: difficultyEvidence } : {}),
          ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
        },
        caused_by_event_id: null,
        // solve_check owns its own AI run inside runSolveCheck; this handler holds no
        // single TaskTextResult, so the transient-error event carries no run id/cost.
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[source_verify] catch-block cleanup failed for', questionId, cleanupErr);
    }
    // the recheck claim reached 'sending' but the run threw: the paid
    // call may or may not have happened, so the honest terminal state for THIS
    // attempt is 'unknown' — never re-paid under this command event (a later
    // command needs a new key → a new claim identity).
    if (recheckClaim != null) {
      try {
        await db.transaction(async (tx) => {
          await markPaidEffectUnknown(
            tx,
            recheckClaim.identity,
            recheckClaim.deliveryId,
            `source_verify threw: ${String((err as Error).message ?? err)}`,
            { fence: recheckClaim.fence },
          );
        });
      } catch (markErr) {
        console.error('[source_verify] recheck claim mark-unknown failed', questionId, markErr);
      }
    }
    throw err;
  }
}

export function buildSourceVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SourceVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  return async (jobs) => {
    for (const job of jobs) {
      const questionIds = job.data?.question_ids;
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        console.warn('[source_verify] job missing question_ids', job.id);
        continue;
      }
      const recheckCommandEventId = job.data?.recheck?.command_event_id;
      for (const questionId of questionIds) {
        const result = await runSourceVerify({
          db,
          questionId,
          runTaskFn,
          ...(recheckCommandEventId != null
            ? { recheckCommandEventId, recheckDeliveryId: job.id }
            : {}),
        });
        console.log(`[source_verify] ${questionId} -> ${result.status}`);
      }
    }
  };
}
