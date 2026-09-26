// ====================================================================
// YUK-1052 — issueAssessment（§4.3 Interface：发题时绑定 revision/目标 part/
// 实际材料/选项展示映射；preselected ≠ issued）
// ====================================================================
//
// 本模块承载【发题编排】：请求 → 组根行锁 → 生命周期校验 → 绑定推导 →
// 不可变 issuance 行 + 一次性 claim（如需）。它不评分、不写学习状态、不
// 创建 submission —— 提交/草稿由 submit.ts 承担。
//
// 关键语义（grounding §3.1/§3.3/§7.1）：
//   - in_progress 必须绑定明确版本：本行一旦写入即【永久 serve 记录】，提交时
//     绝不回取 latest revision（BEFORE UPDATE trigger 冻结绑定列）。
//   - preselected ≠ issued：只有当本函数实际插入行时才产生 issuance ——
//     把题选进纸卷/流不代表已发题。
//   - 选项展示映射：默认 = 声明顺序（§7.3 新 serve 不 shuffle，"以上都对"/
//     引用字母选项保持原序）；允许调用方给覆盖顺序（必须是声明选项的排列）。
//   - 材料绑定：只绑发出 part 实际引用的材料，asset_digest 取 revision 冻结
//     值（判分与学生所见同版）。
//   - 挂起/撤回（§3.3）：suspended ⇒ 禁止新 issuance（含已选入纸卷但未发出的
//     槽）；withdrawn 同理。container_only 组必须声明容器 occurrence 引用。
//   - admission（auto_score 默认）：scoring_admission_state ≠ 'admitted' ⇒
//     not_admitted —— 未准入题不得作为自动判分练习发出（§7.3；手动练习走
//     mode='manual'）。
//   - 一次性 claim：claim_policy='one_time' 的组在请求 claim 时原子占用（同
//     组有 claimed 且未释放的 issuance ⇒ claim_unavailable）；claim 到期/
//     恢复由 releaseIssuanceClaim（activate.ts）处理，claim 恢复绝不复活被
//     verify 撤回的题 —— 本函数以 suspended/withdrawn 维度先行拒绝。
//
// 幂等（第 1 类“已发”合同）：
//   - issuance_id 冲突且绑定载荷逐字段一致 ⇒ status='replayed'（不发新 issuance，
//     不改变 claim —— 重试安全）；
//   - 同 issuance_id 但绑定/容器 ref 不同 ⇒ status='issuance_id_conflict'
//     （显式冲突，不覆盖、不静默改判 —— 与 §4.3「同幂等键不同 payload 冲突」同律）。
//
// 锁序（与 publish/verify 链一致）：question 组根行 FOR UPDATE → 所有组快照
// 读。发题/激活与 verify 状态变更串行化落在同一锁点（§3.3）。
// ====================================================================

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';

// jsonb 会重排对象键序 —— 绑定载荷比对必须用 canonical 串化，否则每次重试
// 都被误判成 issuance_id_conflict（同 judgment.ts 的幂等口径）。
import { stableStringify } from '@/core/migration/canonical';
import type { PracticeIssuanceDtoT, PublishedQuestionRevisionT } from '@/core/schema/assessment';
import {
  type AssessmentIssuanceT,
  deriveIssuanceBinding,
  projectPracticeIssuance,
  validateIssuanceBinding,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';

/** 发题事件 action 名（receipt 即事件载荷；traceable 发题事实）。 */
export const ASSESSMENT_ISSUANCE_ACTION = 'experimental:assessment_issuance';
export const ASSESSMENT_ISSUANCE_VERSION = 1 as const;

// ---------- 输入契约 ----------

export interface IssueAssessmentRequest {
  /** 组根 question id（单题 = 自身；复合题 = 父 id）。 */
  group_id: string;
  /**
   * 显式目标 revision（缺省 = lifecycle.current_revision_id）。in_progress
   * 必须绑定明确版本：给出显式值时它必须是该组的 revision，否则
   * revision_mismatch —— 绝不静默回退到 current。
   */
  revision_id?: string;
  /**
   * 目标 part 子集（缺省 = 全部 parts）。部分发出时只绑定该范围内的槽位与
   * 材料；跨 part 的联合判分由 evaluateSubmission 的 issued_part_ids 切分。
   */
  part_ids?: string[];
  /**
   * 选择槽呈现顺序覆盖（slot_id → option_ids 排列）。缺省 = 声明顺序
   * （§7.3 不 shuffle）。覆盖必须是该槽声明选项的排列，否则 binding_invalid。
   */
  option_order_overrides?: Record<string, readonly string[]>;
  /**
   * 发题模式：
   *   - 'auto_score'（默认）：要求 scoring_admission_state='admitted'；
   *   - 'manual'（D9）：允许未准入组的显式手动/自评练习（仅手动学习效应，
   *     绝不推断 AI 正确性）—— admission generation 仍原样观测记录。
   */
  mode?: 'auto_score' | 'manual';
  /**
   * 容器 occurrence 引用（teaching/probe/intervention/paper 等一次性或容器
   * 内发题锚点）。container_only 组【必须】提供（否则该题没有合法使用面）。
   */
  container_occurrence_ref?: string | null;
  /**
   * 请求一次性占用（claim_status='claimed' + claimed_by_ref）。one_time 组
   * 的 claim 是互斥的：同组存在另一个 claimed 且未释放的 issuance ⇒
   * claim_unavailable（releaseIssuanceClaim 释放后才可再占）。
   */
  claim?: { claimed_by_ref: string };
  /** 客户端可指定 issuance_id（重试幂等锚）；缺省服务端生成。 */
  issuance_id?: string;
  /** 调用方 provenance（事件 actor_ref；缺省 'assessment:issue'）。 */
  actorRef?: string;
  now?: Date;
}

// ---------- 结果 ----------

export type IssueAssessmentResult =
  | {
      status: 'issued' | 'replayed';
      issuance: AssessmentIssuanceT;
      practice_dto: PracticeIssuanceDtoT;
      /** 发题时观测到的 admission generation（激活 CAS 用；未发布组为 null）。 */
      admission_generation_observed: number | null;
    }
  | {
      status:
        | 'not_found' // 组根不存在 / 目标 revision 不存在
        | 'unpublished' // 组从未发布（无 lifecycle.current_revision_id）
        | 'revision_mismatch' // 显式指定的 revision 不属于该组
        | 'suspended' // verify/retraction 挂起 ⇒ 禁止新 issuance（§3.3）
        | 'withdrawn'
        | 'not_admitted' // auto_score 面未获评分准入
        | 'container_ref_required' // container_only 缺 occurrence ref
        | 'claim_unavailable' // one_time 组已有未释放 claim
        | 'issuance_id_conflict' // 同 id 不同绑定载荷（不覆盖）
        | 'binding_invalid'; // 绑定与 revision 不一致（unknown part/material/...）
      issues?: string[]; // binding_invalid 时给出具体 issue 列表
    };

// ---------- 编排主体 ----------

/**
 * issueAssessment：在单一事务内完成 组根锁 → 生命周期校验 → 绑定推导 →
 * 不可变 issuance 落库（+ 可选一次性 claim）。
 *
 * db 可传 Db（自开顶层事务）或 Tx（落到调用方 savepoint，参与更大原子单元
 * —— 如 paper 开卷同事务批量发题）。返回结果不抛 domain 错；契约违背
 * （空 part_ids / 非法 claim 形状）抛 TypeError/Error。
 */
export async function issueAssessment(
  db: Db | Tx,
  request: IssueAssessmentRequest,
): Promise<IssueAssessmentResult> {
  if (request.part_ids != null && request.part_ids.length === 0) {
    throw new Error('issueAssessment: part_ids may not be an empty array');
  }
  const now = request.now ?? new Date();
  const actorRef = request.actorRef ?? 'assessment:issue';
  const mode = request.mode ?? 'auto_score';

  return await db.transaction(async (tx) => {
    // 1) 组根行锁（锁序与 publish/verify 一致：question → lifecycle/快照读）。
    const [root] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, request.group_id))
      .for('update')
      .limit(1);
    if (!root) return { status: 'not_found' };

    // 2) lifecycle + 目标 revision 解析（显式 revision_id 优先 —— 不发 latest）。
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, request.group_id))
      .limit(1);
    const revisionId = request.revision_id ?? lifecycle?.current_revision_id ?? null;
    if (revisionId == null) {
      return { status: 'unpublished' };
    }
    const [revRow] = await tx
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, revisionId))
      .limit(1);
    if (revRow == null) return { status: 'not_found' };
    // 显式指定时必须属于该组 —— 拿 A 组的 revision 发 B 组的题是坐标违背。
    if (revRow.group_id !== request.group_id) {
      return { status: 'revision_mismatch' };
    }

    // 3) 生命周期维度校验（§3.3：挂起/撤回 ⇒ 不发新 issuance）。
    if (lifecycle != null) {
      if (lifecycle.withdrawn) return { status: 'withdrawn' };
      if (lifecycle.suspended) return { status: 'suspended' };
      if (lifecycle.availability === 'container_only' && request.container_occurrence_ref == null) {
        return { status: 'container_ref_required' };
      }
    }
    if (mode === 'auto_score' && lifecycle?.scoring_admission_state !== 'admitted') {
      return { status: 'not_admitted' };
    }

    // 4) 绑定推导 + 校验（revision 快照 → 发出范围/材料/呈现顺序）。
    const revision: PublishedQuestionRevisionT = {
      revision_id: revRow.revision_id,
      group_id: revRow.group_id,
      revision_ordinal: revRow.revision_ordinal,
      integrity_digest: revRow.integrity_digest,
      structure: revRow.structure,
      response_spec: revRow.response_spec,
      scoring_basis: revRow.scoring_basis,
      execution_plan: revRow.execution_plan,
      published_at: revRow.published_at.toISOString(),
      supersedes_revision_id: revRow.supersedes_revision_id,
    };
    const binding = deriveIssuanceBinding(revision, {
      part_ids: request.part_ids,
      option_order_overrides: request.option_order_overrides,
    });
    const bindingIssues = validateIssuanceBinding(binding, revision);
    if (bindingIssues.length > 0) {
      return {
        status: 'binding_invalid',
        issues: bindingIssues.map((issue) => `${issue.code}(${issue.detail})`),
      };
    }

    // 5) 一次性 claim（one_time 组请求占用时）：同组存在未释放 claimed
    //    issuance ⇒ claim_unavailable。unbounded 组始终可发（claim 只是记录）。
    const claimPolicy = lifecycle?.claim_policy ?? 'unbounded';
    const claimRequested = request.claim != null;
    if (claimRequested && claimPolicy === 'one_time') {
      const [holder] = await tx
        .select({ issuance_id: assessment_issuance.issuance_id })
        .from(assessment_issuance)
        .innerJoin(
          question_revision,
          eq(assessment_issuance.revision_id, question_revision.revision_id),
        )
        .where(
          and(
            eq(question_revision.group_id, request.group_id),
            eq(assessment_issuance.claim_status, 'claimed'),
          ),
        )
        .limit(1);
      if (holder != null) return { status: 'claim_unavailable' };
    }

    // 6) issuance 行（不可变绑定；claim 列随后可改）。
    const issuanceId = request.issuance_id ?? `iss_${createId()}`;
    const claimStatus: 'claimed' | 'unclaimed' = claimRequested ? 'claimed' : 'unclaimed';
    const claimedByRef = claimRequested ? (request.claim?.claimed_by_ref ?? null) : null;

    const insertPayload = {
      issuance_id: issuanceId,
      revision_id: revision.revision_id,
      part_ids: binding.part_ids,
      material_bindings: binding.material_bindings,
      option_order: binding.option_order,
      container_occurrence_ref: request.container_occurrence_ref ?? null,
      claim_policy: claimPolicy,
      claim_status: claimStatus,
      claimed_by_ref: claimedByRef,
      issued_at: now,
    };

    const inserted = await tx
      .insert(assessment_issuance)
      .values(insertPayload)
      .onConflictDoNothing({ target: assessment_issuance.issuance_id })
      .returning({ issuance_id: assessment_issuance.issuance_id });

    let status: 'issued' | 'replayed' = 'issued';
    if (inserted.length === 0) {
      // 同 id 已存在：比对完整绑定载荷 —— 一致 = 幂等重放；不同 = 显式冲突。
      const [existing] = await tx
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, issuanceId))
        .limit(1);
      if (existing == null) {
        // 不可能形状（冲突但行不可见）—— fail-loud。
        throw new Error(
          `issueAssessment: issuance '${issuanceId}' conflicted but no row is visible`,
        );
      }
      const sameBinding =
        existing.revision_id === insertPayload.revision_id &&
        stableStringify(existing.part_ids) === stableStringify(insertPayload.part_ids) &&
        stableStringify(existing.material_bindings) ===
          stableStringify(insertPayload.material_bindings) &&
        stableStringify(existing.option_order) === stableStringify(insertPayload.option_order) &&
        (existing.container_occurrence_ref ?? null) === insertPayload.container_occurrence_ref &&
        existing.claim_policy === insertPayload.claim_policy;
      if (!sameBinding) return { status: 'issuance_id_conflict' };
      status = 'replayed';
      // 重放绝不改变 claim —— 若本次请求带 claim 而已有行是 unclaimed，如实返回
      // 现有状态（调用方决定是否再 claim；claim 请求只对 first-serve 有效）。
    } else {
      // 7) 发题事件（同事务 receipt；payload 如实记录冻结坐标与 claim 处置）。
      await writeEvent(tx, {
        id: `evt_iss_${createId()}`,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: actorRef,
        action: ASSESSMENT_ISSUANCE_ACTION,
        subject_kind: 'issuance',
        subject_id: issuanceId,
        outcome: 'success',
        payload: {
          version: ASSESSMENT_ISSUANCE_VERSION,
          issuance_id: issuanceId,
          group_id: request.group_id,
          revision_id: revision.revision_id,
          part_ids: binding.part_ids,
          material_bindings: binding.material_bindings,
          option_order: binding.option_order,
          container_occurrence_ref: insertPayload.container_occurrence_ref,
          claim_policy: claimPolicy,
          claim_status: claimStatus,
          claimed_by_ref: claimedByRef,
          admission_generation_observed: lifecycle?.scoring_admission_generation ?? null,
          mode,
        } satisfies Record<string, unknown>,
        created_at: now,
      });
    }

    const issuance: AssessmentIssuanceT = {
      issuance_id: issuanceId,
      binding,
      issued_at: now.toISOString(),
      claim: {
        policy: claimPolicy,
        status: claimStatus,
        claimed_by_ref: claimedByRef,
      },
    };
    return {
      status,
      issuance,
      practice_dto: projectPracticeIssuance(revision, issuance),
      admission_generation_observed: lifecycle?.scoring_admission_generation ?? null,
    };
  });
}
