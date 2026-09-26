// YUK-1043 — 统一发布链 · publisher（grounding §3.1/§3.3、§4.3 Interface）。
//
// 单一 seam：工作副本编辑 → 原子发布。一次事务内完成：
//   1. 新 question_revision（不可变；唯一键 (group_id, revision_ordinal)）；
//   2. question_group_lifecycle current pointer + §3.3 维度（availability /
//      scoring admission + generation / claim policy / suspension / withdrawal）；
//   3. experimental:assessment_publish 发布事件（ADR-0006 v2 explore 命名空间，
//      payload 松守；稳定后 promote）+ 跨版本 identity diff（P1-4 映射轨迹）。
// 任一步失败 ⇒ 整体回滚（db.transaction；传 Tx 时退化为 SAVEPOINT，外层
// 回滚仍整体丢弃 —— publisher 永不跨事务）。
//
// group 约定（§3.1「physical question 行保留现有 ID」）：单题 = 1-part 组，
// group_id = 该 question.id；composite part（parent_question_id 非空）的组 =
// 父 question.id。legacy `question` 行是工作副本 + 读投影 —— publisher 不重写
// 其内容列（编辑方已写）；dual existence 直到 cutover（YUK-1059）。
//
// CAS（复审 P1-1/P1-5）：双令牌 —— expectedCurrentRevision（null-or-id）与
// expectedAdmissionGeneration（null-or-number，更新既有 lifecycle 的 admission
// 维度时必须匹配当前 generation）。禁止省略当无条件覆盖；并发发布/编辑用
// 组根 question 行 + lifecycle 行的 SELECT ... FOR UPDATE 串行化（锁序：
// question 根 → lifecycle，所有 group 写口一致；publishQuestionGroupFromRow
// 在任何组快照读【之前】先锁组根 —— 复审 P1-1 的 snapshot-then-lock 竞态）。
//
// Claim/lifecycle 分离（§3.2）：live 去重 claim = legacy
// canonical_content_hash 部分唯一索引（archive 置 NULL 释放、restore 原子重取
// —— 见 archiveGroupLifecycle/restoreGroupLifecycle）；lifecycle 只承载政策与
// 挂起/撤回维度，不持有去重键 —— 两者独立版本化。
//
// Admission（§3.3 / D1；复审 P1-5）：
//   - admitted 必须带 evidence + decided_at（DB CHECK），且 evidence 自身必须
//     是【通过的】核验（structural_check_passed=true；independent_verification
//     若存在必须 passed=true）—— 失败核验不得作为准入证据；
//   - 内容变更（digest 变化）产生新 scoring basis ⇒ 旧 admission evidence 不
//     再适用：FromRow 的 preserve 在内容变更时折叠为 withheld（沿用既有
//     withheld 原因），fresh admission 须由 promote/accept 路径显式给出；
//   - 维度更新（admission_updated）受 expectedAdmissionGeneration CAS 保护
//     —— 过期的准入/挂起请求不能覆盖更新的决定。

import { createHash } from 'node:crypto';

import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from 'drizzle-orm';

import type {
  AdmissionEvidenceT,
  ExecutionPlanT,
  QuestionGroupStructureT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  validateExecutionPlan,
  validateResponseSpec,
  validateScoringBasis,
} from '@/core/schema/assessment';
import {
  QUESTION_AVAILABILITY,
  SCORING_ADMISSION_STATE,
  SCORING_ADMISSION_WITHHELD_REASON,
} from '@/core/schema/assessment/lifecycle';
import type { Db, Tx } from '@/db/client';
import {
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
  source_asset,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { contractIntegrityDigest, normalizeQuestionGroupToContract } from './contract-normalizer';

export const ASSESSMENT_PUBLISH_ACTION = 'experimental:assessment_publish' as const;

/** §3.3 withheld 原因（与 lifecycle CHECK 枚举一致）。 */
export type WithheldReason =
  | 'unverified_rules'
  | 'verification_failed'
  | 'no_admitted_executor'
  | 'owner_hold';

export interface PublishAdmission {
  state: 'admitted' | 'withheld';
  /** admitted 必填（D1 双门证据；核验必须是通过的 —— assertAdmissionShape）。 */
  evidence?: AdmissionEvidenceT | null;
  /** withheld 必填。 */
  reason?: WithheldReason;
}

/** §3.3 suspension 维度（与 lifecycle CHECK 枚举一致）。verify 挂起
 * 'verify_hold'；retraction_hold 预留（生命周期层不参与本票接线）。 */
export type SuspensionReason = 'verify_hold' | 'retraction_hold';

export interface SuspensionUpdate {
  suspended: boolean;
  /** suspended=true 必填。 */
  reason?: SuspensionReason;
}

/** 新式 verify 记录（§3.3「新verify保存 (revision_id,digest,policy,
 * generation)」）—— publisher 在同一发布事务内追加
 * question_admission_verification（append-only）。 */
export interface AdmissionVerificationWrite {
  /** 核验 policy 标识（调用方命名空间，如 'quiz_verify@1'）。 */
  policy_id: string;
  /** passed=核验通过；suspended=挂起（含 needs_review / transient hold）；
   * failed=失败复核（记录证据，不改变 admission 决定）。 */
  outcome: 'passed' | 'suspended' | 'failed';
  /** 核验摘要证据（verdict/checks 投影），如实记录。 */
  evidence?: Record<string, unknown>;
}

/** 发布输入：契约四层由 contract-normalizer 产出（此处只收成品）。 */
export interface PublishQuestionGroupInput {
  group_id: string;
  contract: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
    execution_plan: ExecutionPlanT;
    integrity_digest: string;
  };
  /** REQUIRED null-or-id CAS：null = 期望尚无发布；id = 期望替换的当前版本。 */
  expectedCurrentRevision: string | null;
  /**
   * REQUIRED null-or-number CAS（P1-5）：更新【既有】lifecycle 的 admission
   * 维度（含随新 revision 的 admission 写入）时必须匹配当前 generation；
   * null = 期望 lifecycle 尚不存在（首版发布）。
   */
  expectedAdmissionGeneration: number | null;
  availability: 'general_pool' | 'container_only';
  admission: PublishAdmission;
  actorRef: string;
  claimPolicy?: 'one_time' | 'unbounded';
  /** YUK-1045 — suspension 维度更新（§3.3 verify 挂起）。缺省 = 不改变当前
   *  suspension；{suspended:true, reason} 挂起；{suspended:false} 解除 —— 仅
   *  清除 verify_hold（retraction_hold 不属本票接线，恒被保留，不由 verify
   *  promote 顺手清空）。suspension 是独立版本化维度：只在维度变化时
   *  翻 generation+1（与 admission 同事件）。 */
  suspension?: SuspensionUpdate;
  /** YUK-1045 — 本发布随附的新式 verify 记录（§3.3）。publish/admission_update/
   *  noop 路径只要有 verify 输入即追加一行（revision_id 取结果 current/新
   *  revision；digest 取该 revision 的 integrity_digest；generation 取写入后
   *  admission generation）。conflict/withdrawn 不写（无 revision 提交语义）。 */
  verification?: AdmissionVerificationWrite;
  /** 发布者 provenance（jsonb published_by；缺省 NULL）。 */
  publishedBy?: unknown;
  now: Date;
}

export type PublishQuestionGroupResult =
  | {
      status: 'published';
      revision_id: string;
      revision_ordinal: number;
      group_id: string;
      event_id: string;
      admission_generation: number;
      /** 新 revision 的 integrity_digest（verify 记录用）。 */
      revision_digest: string;
    }
  | {
      /** 内容未变但 §3.3 维度变了（promote/挂起等）：只更新 lifecycle 维度
       * （generation+1）+ 事件，不铸新 revision —— admission 与内容各自独立版本化。 */
      status: 'admission_updated';
      group_id: string;
      current_revision_id: string;
      admission_generation: number;
      /** 当前 revision 的 integrity_digest（verify 记录用）。 */
      revision_digest: string;
      event_id: string;
    }
  | {
      /** 组无可发布成员（全部子 part tombstone）：不铸空组 revision，只落
       * 撤回维度（P2 组语义）。 */
      status: 'withdrawn';
      group_id: string;
    }
  | {
      status: 'noop';
      group_id: string;
      current_revision_id: string;
      reason: 'digest_unchanged';
      /** 当前 revision digest + 当前 admission generation（verify 记录用）。 */
      revision_digest: string;
      admission_generation: number;
    }
  | {
      status: 'conflict';
      group_id: string;
      current_revision_id: string | null;
      reason: 'revision_cas' | 'admission_generation_cas';
    };

function assertAdmissionShape(admission: PublishAdmission): void {
  if (admission.state === 'admitted') {
    const evidence = admission.evidence;
    if (evidence == null) {
      throw new Error('publishQuestionGroup: admitted requires evidence (D1 dual-gate)');
    }
    // P1-5 —— 失败的核验不是准入证据。
    if (evidence.verification.structural_check_passed !== true) {
      throw new Error(
        'publishQuestionGroup: admitted evidence must have structural_check_passed=true',
      );
    }
    const independent = evidence.verification.independent_verification;
    if (independent != null && independent.passed !== true) {
      throw new Error(
        'publishQuestionGroup: admitted evidence must carry a PASSED independent verification (D1)',
      );
    }
    return;
  }
  if (admission.reason == null) {
    throw new Error('publishQuestionGroup: withheld requires a reason (lifecycle branch CHECK)');
  }
}

function assertSuspensionShape(suspension: SuspensionUpdate): void {
  if (suspension.suspended && suspension.reason == null) {
    throw new Error('publishQuestionGroup: suspended=true requires a reason (lifecycle CHECK)');
  }
}

/** 解析 suspension 维度更新 → lifecycle 列值。
 * 返回 null = 该输入对【当前】lifecycle 无效果（缺省输入；或
 * suspended=false 面对非 verify_hold 的既有挂起 —— verify promote 不许顺手
 * 清 retraction_hold，下同）。suspended=true 总是有效（覆盖既有原因），但
 * 【verify_hold 不得遮蔽并存 retraction_hold】：suspension_reason 单列只能
 * 留一个原因，且 clear 只会解除 verify_hold（置 suspended=false）——若先让
 * verify_hold 覆写 retraction_hold，之后的复核通过会把整个挂起（含尚有效
 * 的撤回保持）一并清掉。verify_hold 落在已有 retraction_hold 上是 no-op
 * （仍是 suspended=true, reason=retraction_hold），核验证据只进
 * verification 行，维度意图如实表达为『verify 无权改判 retraction』。 */
function suspensionValuesFor(
  lifecycle: typeof question_group_lifecycle.$inferSelect | undefined,
  suspension: SuspensionUpdate | undefined,
): { suspended: boolean; suspension_reason: SuspensionReason | null } | null {
  if (suspension == null) return null;
  if (suspension.suspended) {
    const reason = suspension.reason ?? 'verify_hold';
    if (
      reason === 'verify_hold' &&
      lifecycle?.suspended === true &&
      lifecycle.suspension_reason === 'retraction_hold'
    ) {
      return { suspended: true, suspension_reason: 'retraction_hold' };
    }
    return { suspended: true, suspension_reason: reason };
  }
  // suspended=false：只清 verify_hold；retraction_hold 及其它持有原因恒保留
  //（verify 复核无权解除非 verify 挂起）。
  if (lifecycle?.suspension_reason !== 'verify_hold') return null;
  return { suspended: false, suspension_reason: null };
}

/** 递归按 key 排序的确定性序列化 —— jsonb 读回不保留 key 顺序，维度比对
 *（evidence 深比较）必须与顺序无关，否则幂等重发会被误判为维度变化。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** §3.3 维度是否与当前 lifecycle 完全一致（一致 ⇒ 真 noop；不一致 ⇒ 只更新维度）。 */
function lifecycleDimensionsMatch(
  lifecycle: typeof question_group_lifecycle.$inferSelect | undefined,
  input: PublishQuestionGroupInput,
): boolean {
  if (!lifecycle) return false;
  if (input.availability !== lifecycle.availability) return false;
  if (input.claimPolicy != null && input.claimPolicy !== lifecycle.claim_policy) return false;
  // suspension 维度：解析后的目标值必须与现状一致才算 noop。
  const nextSuspension = suspensionValuesFor(lifecycle, input.suspension);
  if (nextSuspension != null) {
    if (
      nextSuspension.suspended !== lifecycle.suspended ||
      nextSuspension.suspension_reason !== (lifecycle.suspension_reason ?? null)
    ) {
      return false;
    }
  }
  if (input.admission.state === 'admitted') {
    return (
      lifecycle.scoring_admission_state === SCORING_ADMISSION_STATE.ADMITTED &&
      stableStringify(input.admission.evidence ?? null) ===
        stableStringify(lifecycle.scoring_admission_evidence ?? null)
    );
  }
  return (
    lifecycle.scoring_admission_state === SCORING_ADMISSION_STATE.WITHHELD &&
    lifecycle.scoring_admission_withheld_reason === input.admission.reason
  );
}

function admissionValuesFor(admission: PublishAdmission, now: Date) {
  return admission.state === 'admitted'
    ? {
        scoring_admission_state: 'admitted' as const,
        scoring_admission_evidence: admission.evidence ?? null,
        scoring_admission_withheld_reason: null,
        scoring_admission_decided_at: now,
      }
    : {
        scoring_admission_state: 'withheld' as const,
        scoring_admission_evidence: null,
        scoring_admission_withheld_reason: admission.reason ?? 'owner_hold',
        scoring_admission_decided_at: null,
      };
}

/** 跨版本 identity diff（P1-3/P1-4 —— 映射轨迹随发布事件原子持久化）。
 * 语义裁决（复审第二轮）：part id 相同 ≠ 语义连续 —— 判分相关内容
 *（题面/选项文本集/答案键/规则文本）实质变化 ⇒ 【replaced】+ 显式
 * old→new fingerprint 映射；内容等价才 retained。保守规则：无法判定
 *（旧版形状缺失等）⇒ replaced，绝不静默记 retained。 */
export interface PartChange {
  part_id: string;
  status: 'retained' | 'replaced' | 'added' | 'removed';
}

export interface ReplacementMapping {
  part_id: string;
  previous_fingerprint: string;
  next_fingerprint: string;
}

export interface IdentityDiff {
  part_changes: PartChange[];
  /** slot 级 option 增删（option 文本变 ⇒ 新身份 = 语义替换；label 不参与身份）。 */
  option_changes: { slot_id: string; added_option_ids: string[]; removed_option_ids: string[] }[];
  /** replaced part 的 old→new 判分内容 fingerprint 映射（§3.1 身份映射 seam）。 */
  replacement_mappings: ReplacementMapping[];
}

/** part 的判分相关内容 fingerprint：题面 + 材料 + 选项文本集 + criterion。
 * 变化 ⇒ 语义替换（无论行/node id 是否保留）。stable 序列化（jsonb 读回
 * key 顺序无关）。 */
function partFingerprint(
  partId: string,
  structure: QuestionGroupStructureT,
  spec: ResponseSpecT,
  basis: ScoringBasisT,
): string | null {
  const part = structure.parts.find((p) => p.part_id === partId);
  if (part == null) return null;
  const slot = spec.slots.find((s) => s.part_id === partId);
  const unit = basis.units.find((u) => u.scoring_unit_id === `${partId}::u`);
  if (slot == null || unit == null) return null; // 形状异常 ⇒ 无法判定
  const options =
    slot.kind === 'single_choice' || slot.kind === 'multi_choice'
      ? slot.options.map((o) => `${o.option_id}:${o.text}`).sort()
      : [];
  const canonical = stableStringify({
    prompt: part.prompt_md,
    material_ids: [...part.material_ids].sort(),
    options,
    criterion: unit.criterion,
  });
  return `fp_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/** 与被替换版本比对，产出【语义】identity diff（P1-3 裁决）。 */
function computeIdentityDiff(
  previous: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
  } | null,
  next: {
    structure: QuestionGroupStructureT;
    response_spec: ResponseSpecT;
    scoring_basis: ScoringBasisT;
  },
): IdentityDiff {
  const optionChangesFor = (prev: ResponseSpecT | null): IdentityDiff['option_changes'] => {
    const prevOptionsBySlot = new Map(
      (prev?.slots ?? []).flatMap((slot) =>
        slot.kind === 'single_choice' || slot.kind === 'multi_choice'
          ? [[slot.slot_id, new Set(slot.options.map((o) => o.option_id))] as const]
          : [],
      ),
    );
    const changes: IdentityDiff['option_changes'] = [];
    for (const slot of next.response_spec.slots) {
      if (slot.kind !== 'single_choice' && slot.kind !== 'multi_choice') continue;
      const prevOpts = prevOptionsBySlot.get(slot.slot_id) ?? new Set<string>();
      const current = slot.options.map((o) => o.option_id);
      const added = current.filter((id) => !prevOpts.has(id));
      const removed = [...prevOpts].filter((id) => !current.includes(id));
      if (added.length > 0 || removed.length > 0) {
        changes.push({
          slot_id: slot.slot_id,
          added_option_ids: added,
          removed_option_ids: removed,
        });
      }
    }
    return changes;
  };

  if (previous == null) {
    return {
      part_changes: next.structure.parts.map((p) => ({
        part_id: p.part_id,
        status: 'added' as const,
      })),
      option_changes: optionChangesFor(null),
      replacement_mappings: [],
    };
  }
  const prevParts = new Set(previous.structure.parts.map((p) => p.part_id));
  const nextParts = new Set(next.structure.parts.map((p) => p.part_id));
  const partChanges: PartChange[] = [];
  const replacementMappings: ReplacementMapping[] = [];
  for (const partId of nextParts) {
    if (!prevParts.has(partId)) {
      partChanges.push({ part_id: partId, status: 'added' });
      continue;
    }
    const prevFp = partFingerprint(
      partId,
      previous.structure,
      previous.response_spec,
      previous.scoring_basis,
    );
    const nextFp = partFingerprint(partId, next.structure, next.response_spec, next.scoring_basis);
    // 保守裁决：fingerprint 不可得（形状异常）或内容实质变化 ⇒ replaced。
    if (prevFp != null && nextFp != null && prevFp === nextFp) {
      partChanges.push({ part_id: partId, status: 'retained' });
    } else {
      partChanges.push({ part_id: partId, status: 'replaced' });
      replacementMappings.push({
        part_id: partId,
        previous_fingerprint: prevFp ?? 'unrecoverable',
        next_fingerprint: nextFp ?? 'unrecoverable',
      });
    }
  }
  for (const partId of prevParts) {
    if (!nextParts.has(partId)) partChanges.push({ part_id: partId, status: 'removed' });
  }
  return {
    part_changes: partChanges,
    option_changes: optionChangesFor(previous.response_spec),
    replacement_mappings: replacementMappings,
  };
}

/**
 * 统一发布 seam。db 可传事务句柄（推荐 —— 与调用方的编辑写同事务）或独立
 * Db（publisher 自开顶层事务）。契约校验失败抛错（fail-closed）；CAS 不匹配
 * 返回 'conflict'；digest 与当前版一致且 §3.3 维度也一致返回 'noop'（不产生
 * 版本 churn）；digest 一致但维度变化返回 'admission_updated'（只更新 lifecycle
 * 维度 + generation，不铸新 revision）。
 *
 * P2：integrity_digest 在 seam 内重算核对（防调用方漂移），structure.group_id
 * 必须与目标 group 一致。
 */
export async function publishQuestionGroup(
  db: Db | Tx,
  input: PublishQuestionGroupInput,
): Promise<PublishQuestionGroupResult> {
  assertAdmissionShape(input.admission);
  if (input.suspension != null) assertSuspensionShape(input.suspension);

  // Db → 顶层事务；Tx → SAVEPOINT（drizzle 嵌套事务）。两种情况下任一步
  // 失败都整体回滚本次发布的全部写入。
  return db.transaction(async (tx) => {
    const { contract, group_id: groupId } = input;

    // P2 —— digest 由 seam 重算（调用方只给契约；digest 不是独立输入）。
    const recomputed = contractIntegrityDigest(contract);
    if (recomputed !== contract.integrity_digest) {
      throw new Error(
        `publishQuestionGroup: integrity_digest mismatch (supplied ${contract.integrity_digest}, recomputed ${recomputed}) — regenerate the contract via contract-normalizer`,
      );
    }
    if (contract.structure.group_id !== groupId) {
      throw new Error(
        `publishQuestionGroup: contract structure.group_id '${contract.structure.group_id}' != target group '${groupId}'`,
      );
    }

    // 契约确定性校验 fail-closed（referential integrity / 恰好一次覆盖）。
    const specIssues = validateResponseSpec(contract.response_spec, contract.structure);
    if (specIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: response_spec invalid: ${specIssues.map((i) => i.code).join(',')}`,
      );
    }
    const basisIssues = validateScoringBasis(
      contract.scoring_basis,
      contract.response_spec,
      contract.structure,
    );
    if (basisIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: scoring_basis invalid: ${basisIssues.map((i) => i.code).join(',')}`,
      );
    }
    const planIssues = validateExecutionPlan(contract.execution_plan, contract.scoring_basis);
    if (planIssues.length > 0) {
      throw new Error(
        `publishQuestionGroup: execution_plan invalid: ${planIssues.map((i) => i.code).join(',')}`,
      );
    }

    // 组级串行化：锁根 question 行（发布与编辑同一锁序 question → lifecycle）。
    const [root] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, groupId))
      .for('update')
      .limit(1);
    if (!root) {
      throw new Error(`publishQuestionGroup: root question row '${groupId}' not found`);
    }

    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, groupId))
      .for('update')
      .limit(1);
    const currentRevisionId = lifecycle?.current_revision_id ?? null;

    // CAS（REQUIRED null-or-id / null-or-number —— 与调用方期望不符即冲突，不静默覆盖）。
    if (input.expectedCurrentRevision !== currentRevisionId) {
      return {
        status: 'conflict',
        group_id: groupId,
        current_revision_id: currentRevisionId,
        reason: 'revision_cas',
      };
    }
    const currentGeneration = lifecycle?.scoring_admission_generation ?? null;
    if (lifecycle != null && input.expectedAdmissionGeneration !== currentGeneration) {
      return {
        status: 'conflict',
        group_id: groupId,
        current_revision_id: currentRevisionId,
        reason: 'admission_generation_cas',
      };
    }

    let previousContract: {
      structure: QuestionGroupStructureT;
      response_spec: ResponseSpecT;
      scoring_basis: ScoringBasisT;
      ordinal: number;
      digest: string;
    } | null = null;

    // Digest 去重 + §3.3 维度分离：内容与当前版一致时不铸新版本（identity/churn
    // 纪律）；但 admission/availability/claimPolicy 是独立版本化的生命周期维度 ——
    // 不一致时只更新维度（admission generation+1）+ 事件（promote 即此路径：
    // 草稿首版 withheld/unverified_rules → 核验通过后 admitted，内容未变）。
    let nextOrdinal = 1;
    if (currentRevisionId != null) {
      const [current] = await tx
        .select({
          ordinal: question_revision.revision_ordinal,
          digest: question_revision.integrity_digest,
          structure: question_revision.structure,
          response_spec: question_revision.response_spec,
          scoring_basis: question_revision.scoring_basis,
        })
        .from(question_revision)
        .where(eq(question_revision.revision_id, currentRevisionId))
        .limit(1);
      if (current != null) {
        previousContract = current;
      }
      if (current?.digest === contract.integrity_digest) {
        if (lifecycleDimensionsMatch(lifecycle, input)) {
          const noopResult = {
            status: 'noop' as const,
            group_id: groupId,
            current_revision_id: currentRevisionId,
            reason: 'digest_unchanged' as const,
            revision_digest: contract.integrity_digest,
            admission_generation: currentGeneration ?? 0,
          };
          await insertAdmissionVerification(
            tx,
            input,
            currentRevisionId,
            contract.integrity_digest,
            currentGeneration ?? 0,
          );
          return noopResult;
        }
        const admissionGeneration = lifecycle.scoring_admission_generation + 1;
        const suspensionValues = suspensionValuesFor(lifecycle, input.suspension);
        await tx
          .update(question_group_lifecycle)
          .set({
            availability: input.availability,
            ...admissionValuesFor(input.admission, input.now),
            scoring_admission_generation: admissionGeneration,
            ...(suspensionValues ?? {}),
            ...(input.claimPolicy ? { claim_policy: input.claimPolicy } : {}),
            updated_at: input.now,
          })
          .where(eq(question_group_lifecycle.group_id, groupId));
        const dimensionEventId = createId();
        await writeEvent(tx, {
          id: dimensionEventId,
          session_id: null,
          actor_kind: 'system',
          actor_ref: input.actorRef,
          action: ASSESSMENT_PUBLISH_ACTION,
          subject_kind: 'question',
          subject_id: groupId,
          outcome: 'success',
          payload: {
            group_id: groupId,
            revision_id: currentRevisionId,
            dimension_update: true,
            availability: input.availability,
            admission: input.admission.state,
            admission_generation: admissionGeneration,
            // suspension 是本路径可变的第二维度（verify 挂起/解除）；
            // 如实记录目标值（输入缺省 ⇒ 未变，不投影）。
            ...(input.suspension != null
              ? {
                  suspended: suspensionValues?.suspended ?? lifecycle.suspended,
                  suspension_reason:
                    suspensionValues !== null
                      ? suspensionValues.suspension_reason
                      : (lifecycle.suspension_reason ?? null),
                }
              : {}),
            // 同 tx 内 append-only 核验记录的指针投影（policy/outcome；证据本体在
            // question_admission_verification 行 —— 事件 payload 不重复携带）。
            ...(input.verification != null
              ? {
                  verification: {
                    policy_id: input.verification.policy_id,
                    outcome: input.verification.outcome,
                  },
                }
              : {}),
          },
          created_at: input.now,
        });
        await insertAdmissionVerification(
          tx,
          input,
          currentRevisionId,
          current.digest,
          admissionGeneration,
        );
        return {
          status: 'admission_updated',
          group_id: groupId,
          current_revision_id: currentRevisionId,
          admission_generation: admissionGeneration,
          revision_digest: current.digest,
          event_id: dimensionEventId,
        };
      }
      nextOrdinal = (current?.ordinal ?? 0) + 1;
    }

    const revisionId = createId();
    await tx.insert(question_revision).values({
      revision_id: revisionId,
      group_id: groupId,
      revision_ordinal: nextOrdinal,
      integrity_digest: contract.integrity_digest,
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      supersedes_revision_id: currentRevisionId,
      availability: input.availability,
      published_by: (input.publishedBy as never) ?? null,
      published_at: input.now,
    });

    const admissionGeneration = (lifecycle?.scoring_admission_generation ?? 0) + 1;
    const admissionValues = admissionValuesFor(input.admission, input.now);
    const suspensionValues = suspensionValuesFor(lifecycle, input.suspension);

    if (lifecycle) {
      await tx
        .update(question_group_lifecycle)
        .set({
          current_revision_id: revisionId,
          availability: input.availability,
          ...admissionValues,
          scoring_admission_generation: admissionGeneration,
          ...(suspensionValues ?? {}),
          ...(input.claimPolicy ? { claim_policy: input.claimPolicy } : {}),
          updated_at: input.now,
        })
        .where(eq(question_group_lifecycle.group_id, groupId));
    } else {
      await tx.insert(question_group_lifecycle).values({
        group_id: groupId,
        current_revision_id: revisionId,
        availability: input.availability,
        ...admissionValues,
        scoring_admission_generation: admissionGeneration,
        claim_policy: input.claimPolicy ?? 'unbounded',
        // 首版发布可携带 verify 挂起（未发布即挂起的题 —— suspend 输入透传）。
        ...(suspensionValues ?? { suspended: false, suspension_reason: null }),
        withdrawn: false,
        withdrawn_at: null,
        created_at: input.now,
        updated_at: input.now,
      });
    }

    // 发布事件（同事务）+ identity diff（P1-4 映射轨迹）。
    const identityDiff = computeIdentityDiff(previousContract, contract);
    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'system',
      actor_ref: input.actorRef,
      action: ASSESSMENT_PUBLISH_ACTION,
      subject_kind: 'question',
      subject_id: groupId,
      outcome: 'success',
      payload: {
        group_id: groupId,
        revision_id: revisionId,
        revision_ordinal: nextOrdinal,
        supersedes_revision_id: currentRevisionId,
        integrity_digest: contract.integrity_digest,
        availability: input.availability,
        admission: input.admission.state,
        admission_generation: admissionGeneration,
        ...(input.suspension != null
          ? {
              suspended: suspensionValues?.suspended ?? lifecycle?.suspended ?? false,
              suspension_reason:
                suspensionValues != null
                  ? suspensionValues.suspension_reason
                  : (lifecycle?.suspension_reason ?? null),
            }
          : {}),
        // 同 tx 内 append-only 核验记录的指针投影（policy/outcome）。
        ...(input.verification != null
          ? {
              verification: {
                policy_id: input.verification.policy_id,
                outcome: input.verification.outcome,
              },
            }
          : {}),
        identity_changes: identityDiff,
      },
      created_at: input.now,
    });

    await insertAdmissionVerification(
      tx,
      input,
      revisionId,
      contract.integrity_digest,
      admissionGeneration,
    );

    return {
      status: 'published',
      revision_id: revisionId,
      revision_ordinal: nextOrdinal,
      group_id: groupId,
      event_id: eventId,
      admission_generation: admissionGeneration,
      revision_digest: contract.integrity_digest,
    };
  });
}

// ─── 从 legacy 行发布（加载 + 归一 + 发布 的便捷 seam） ─────

export interface PublishFromRowInput {
  /** 组根 question id（单题 = 自身；part 编辑时传父 id）。 */
  rootId: string;
  /** 缺省 preserve：内容未变时沿用当前 admission；内容变更 ⇒ 折叠 withheld
   *（P1-5 —— 新 scoring basis 使旧 evidence 不再适用）。 */
  admission?: PublishAdmission | { state: 'preserve' };
  availability?: 'general_pool' | 'container_only';
  /** YUK-1045 — suspension 维度（§3.3 verify 挂起/同版复核解除）；缺省不改变。 */
  suspension?: SuspensionUpdate;
  /** YUK-1045 — 随发布事务追加的新式 verify 记录（§3.3）。 */
  verification?: AdmissionVerificationWrite;
  /** 缺省不改；首次发布时 'unbounded'。 */
  claimPolicy?: 'one_time' | 'unbounded';
  actorRef: string;
  now: Date;
}

/**
 * 加载组根 + 物理 parts → 归一 → 发布。
 *
 * P1-1：先锁组根行，再做任何组快照读（root/parts/lifecycle）—— 并发兄弟
 * 编辑即使持子行锁，也必须先过组根锁才能提交发布；快照因此总是锁后一致
 * 状态。CAS 令牌（revision + admission generation）都取自锁后读取，本 seam
 * 内不会错版；direct publishQuestionGroup 的 conflict 语义保留给显式调用方。
 * conflict 在此 fail-closed 抛错（外层事务回滚）—— 调用方不允许静默丢弃发布。
 *
 * P1-5：normalizer 报告的未决转换（missing reference 等）⇒ admission 强制
 * withheld（保留调用方更严的决定，绝不放宽）。
 */
export async function publishQuestionGroupFromRow(
  db: Db | Tx,
  input: PublishFromRowInput,
): Promise<PublishQuestionGroupResult> {
  return db.transaction(async (tx) => {
    // P1-1（第二轮复审）—— 锁序修复：先用【非锁定】读解析真实组根（传入行
    // 可能是子 part），然后只对组根取 FOR UPDATE —— 绝不先锁子行再找父
    //（旧实现 lock(child)→lock(parent) 与已修正的 root→child 写口互为死锁序）。
    const supplied = (
      await tx
        .select({ id: question.id, parentId: question.parent_question_id })
        .from(question)
        .where(eq(question.id, input.rootId))
        .limit(1)
    )[0];
    if (!supplied) {
      throw new Error(`publishQuestionGroupFromRow: root question '${input.rootId}' not found`);
    }
    const effectiveRootId = supplied.parentId ?? supplied.id;
    const root = (
      await tx
        .select()
        .from(question)
        .where(eq(question.id, effectiveRootId))
        .for('update')
        .limit(1)
    )[0];
    if (!root) {
      throw new Error(
        `publishQuestionGroupFromRow: group root question '${effectiveRootId}' not found`,
      );
    }
    const rootId = root.id;
    // tombstoned part（archived/dismissed）不是可服务组员 —— 组契约排除之
    //（child archive ⇒ 组内容变化 ⇒ 新 revision，P2 组语义）。
    const partRows = await tx
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        reference_md: question.reference_md,
        choices_md: question.choices_md,
        structured: question.structured,
        figures: question.figures,
        metadata: question.metadata,
      })
      .from(question)
      .where(eq(question.parent_question_id, rootId))
      .orderBy(question.part_index);

    const liveParts = partRows.filter((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.archived_at == null && meta?.dismissed_at == null;
    });

    // 全部子 part 已 tombstone ⇒ 组无可发布成员：不铸空组 revision，只落
    // lifecycle 撤回维度（P2 组语义；历史 revision/摘要保留）。
    if (partRows.length > 0 && liveParts.length === 0) {
      await archiveGroupLifecycle(tx, rootId, input.now);
      return { status: 'withdrawn', group_id: rootId } satisfies PublishQuestionGroupResult;
    }

    // figure 实内容 digest 核验（root + parts 全部 figure 资产）：来自 asset
    // store 元数据（source_asset.sha256，裸 hex）。无核验值 ⇒ normalizer 如实
    // 标 unverified + conversion issue（不伪造 digest）。
    const figureAssetIds = new Set<string>();
    for (const f of root.figures ?? []) figureAssetIds.add(f.asset_id);
    for (const p of liveParts) for (const f of p.figures ?? []) figureAssetIds.add(f.asset_id);
    const figureDigests: Record<string, string> = {};
    if (figureAssetIds.size > 0) {
      const assetRows = await tx
        .select({ assetId: source_asset.id, sha256: source_asset.sha256 })
        .from(source_asset)
        .where(inArray(source_asset.id, [...figureAssetIds]));
      for (const assetRow of assetRows) figureDigests[assetRow.assetId] = assetRow.sha256;
    }

    const contract = normalizeQuestionGroupToContract(
      { ...(root as Parameters<typeof normalizeQuestionGroupToContract>[0]), figureDigests },
      liveParts.map((p) => ({
        id: p.id,
        prompt_md: p.prompt_md,
        reference_md: p.reference_md,
        choices_md: p.choices_md,
        structured: p.structured,
        figures: p.figures,
      })),
    );

    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, rootId))
      .for('update')
      .limit(1);
    const expectedRevision = lifecycle?.current_revision_id ?? null;
    const expectedGeneration = lifecycle?.scoring_admission_generation ?? null;

    const contentChanged =
      expectedRevision == null ||
      lifecycle == null ||
      (await tx
        .select({ digest: question_revision.integrity_digest })
        .from(question_revision)
        .where(eq(question_revision.revision_id, expectedRevision))
        .limit(1)
        .then((rows) => rows[0]?.digest !== contract.integrity_digest));

    // admission 解析（P1-5）：
    //   - preserve + 内容变更 ⇒ withheld（沿用既有 withheld 原因，没有则
    //     unverified_rules）—— 旧 evidence 不越代适用；
    //   - preserve + 内容未变 ⇒ 沿用当前维度（维度一致时上游自然 noop）；
    //   - 未决转换 ⇒ 强制 withheld（不放宽调用方更严的决定）。
    let admission: PublishAdmission;
    if (input.admission != null && input.admission.state !== 'preserve') {
      admission = input.admission;
    } else if (contentChanged) {
      admission = {
        state: 'withheld',
        reason:
          lifecycle?.scoring_admission_state === SCORING_ADMISSION_STATE.WITHHELD
            ? ((lifecycle.scoring_admission_withheld_reason ??
                SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES) as WithheldReason)
            : SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
      };
    } else if (lifecycle?.scoring_admission_state === SCORING_ADMISSION_STATE.ADMITTED) {
      admission = { state: 'admitted', evidence: lifecycle.scoring_admission_evidence ?? null };
    } else {
      admission = {
        state: 'withheld',
        reason: (lifecycle?.scoring_admission_withheld_reason ??
          SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES) as WithheldReason,
      };
    }
    if (contract.conversion_issues.length > 0 && admission.state === 'admitted') {
      admission = {
        state: 'withheld',
        reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
      };
    }

    const result = await publishQuestionGroup(tx, {
      group_id: rootId,
      contract,
      expectedCurrentRevision: expectedRevision,
      expectedAdmissionGeneration: expectedGeneration,
      availability:
        input.availability ??
        lifecycle?.availability ??
        (root.source === 'web_sourced' || root.source === 'quiz_gen'
          ? QUESTION_AVAILABILITY.GENERAL_POOL
          : QUESTION_AVAILABILITY.CONTAINER_ONLY),
      admission,
      suspension: input.suspension,
      verification: input.verification,
      claimPolicy: input.claimPolicy,
      actorRef: input.actorRef,
      now: input.now,
    });

    if (result.status === 'conflict') {
      // 锁后读取 ⇒ 组内不该发生；出现即外部路径越过 seam 写 lifecycle ——
      // fail-closed 回滚整个调用方事务（P1-1：不允许静默丢弃发布）。
      throw new Error(
        `publishQuestionGroupFromRow: unexpected ${result.reason} conflict for group '${rootId}' (lifecycle written outside the seam?)`,
      );
    }
    return result;
  });
}

// ─── lifecycle 维度操作（archive/restore 的 claim 分离语义，§3.2/§3.3） ─────

/** §3.3「新verify保存 (revision_id,digest,policy,generation)」—— 发布事务内
 * 追加 question_admission_verification（append-only，0105 trigger）。仅当调用方
 * 带 verification 输入时写入；generation = 本次写入后的 admission generation。 */
async function insertAdmissionVerification(
  tx: Tx,
  input: PublishQuestionGroupInput,
  revisionId: string,
  revisionDigest: string,
  generation: number,
): Promise<void> {
  const verification = input.verification;
  if (verification == null) return;
  await tx.insert(question_admission_verification).values({
    id: createId(),
    revision_id: revisionId,
    revision_digest: revisionDigest,
    policy_id: verification.policy_id,
    generation,
    outcome: verification.outcome,
    evidence: verification.evidence ?? {},
    recorded_at: input.now,
  });
}

export interface ArchiveGroupLifecycleResult {
  status: 'archived' | 'not_found';
}

/** archive 维度：withdrawn=true（claim 释放由 legacy hash 置 NULL 承担，§3.2）。 */
export async function archiveGroupLifecycle(
  tx: Tx,
  groupId: string,
  now: Date,
): Promise<ArchiveGroupLifecycleResult> {
  const updated = await tx
    .update(question_group_lifecycle)
    .set({ withdrawn: true, withdrawn_at: now, updated_at: now })
    .where(eq(question_group_lifecycle.group_id, groupId))
    .returning({ group_id: question_group_lifecycle.group_id });
  if (updated.length === 0) return { status: 'not_found' };
  return { status: 'archived' };
}

export interface RestoreGroupLifecycleResult {
  status: 'restored' | 'not_found' | 'claim_conflict';
  /** claim_conflict 时：占用同 content hash 的在库 question id。 */
  conflicting_question_id?: string;
}

/**
 * restore 维度：withdrawn=false + 原子重取 live 去重 claim（§3.2「恢复要原子
 * 重新取得claim并处理冲突」）。claim = legacy canonical_content_hash —— 重取
 * 即在根行上条件写入 hash；占用者存在 ⇒ claim_conflict（fail-closed，不静默
 * 改判）。verify 挂起不自动释放 claim（本 seam 不触及 suspension）。
 *
 * 锁序（P2）：question 根行 FOR UPDATE → lifecycle FOR UPDATE，与发布/编辑
 * 一致（此前先锁 lifecycle 与声明锁序相反）。
 */
export async function restoreGroupLifecycle(
  tx: Tx,
  groupId: string,
  canonicalContentHash: string | null,
  now: Date,
): Promise<RestoreGroupLifecycleResult> {
  const [rootLock] = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, groupId))
    .for('update')
    .limit(1);
  if (!rootLock) return { status: 'not_found' };

  const [lifecycle] = await tx
    .select({ group_id: question_group_lifecycle.group_id })
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .for('update')
    .limit(1);
  if (!lifecycle) return { status: 'not_found' };

  if (canonicalContentHash != null) {
    // 先探测占用者（唯一索引冲突时 PG 不告诉你是谁）。
    const [holder] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.canonical_content_hash, canonicalContentHash))
      .limit(1);
    if (holder && holder.id !== groupId) {
      return { status: 'claim_conflict', conflicting_question_id: holder.id };
    }
    const stamped = await tx
      .update(question)
      .set({ canonical_content_hash: canonicalContentHash, updated_at: now })
      .where(eq(question.id, groupId))
      .returning({ id: question.id });
    if (stamped.length === 0) return { status: 'not_found' };
  }

  await tx
    .update(question_group_lifecycle)
    .set({ withdrawn: false, withdrawn_at: null, updated_at: now })
    .where(eq(question_group_lifecycle.group_id, groupId));
  return { status: 'restored' };
}
