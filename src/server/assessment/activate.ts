// ====================================================================
// YUK-1045 — activateEvaluation 编排骨架（grounding §4.3 / §11 / §3.3 时点表）
// ====================================================================
//
// 本模块只承载【activation 编排】：锁序 → 校验 → CAS → 原子提交（head +
// effect receipt 事件）。它不评分、不调模型（模型调用在锁外、由 1047 评估
// seam 完成并把 completed candidate 写进 evaluation 表后才到达这里）。
//
// 锁序（§11「先锁 common learning-write，再一致地锁 submission/head」）：
//   1. `acquireLearningStateWriteLock`（全局学习写锁 G —— 所有学习态写方先取
//      它，天然与结算串行化）；
//   2. `evaluation` candidate 行锁（FOR UPDATE —— 读坐标；evaluation 行不在
//      他人写路径的锁点上，先于 submission/head 取锁不构成环）；
//   3. `assessment_submission` 行锁（FOR UPDATE）；
//   4. `evaluation_effective_head` 行锁（FOR UPDATE —— CAS 串行化点）；
//   5. `question` 组根行锁（FOR UPDATE —— publish/verify 链在
//      `publishQuestionGroupFromRow` 内先取同一锁，故 suspension/admission
//      写与 activation 读在组根行锁上互斥 ⇒ §3.3「发题/激活与 verify 状态
//      变更串行化」落实为同一锁点，而非额外锁面）。
//   所有跨域写方都以 G 为第一锁，无主序颠倒 ⇒ 无环。
//
// admission 校验（§3.3「已排队/正在评估：可以保存 candidate，activation
// 重新核对 admission generation」）：
//   - 组根在组根行锁下读 lifecycle：suspended 或 withdrawn ⇒ stale_admission；
//   - 评估时观察到的 admission generation（请求显式值优先，否则回退读
//     `evaluation.provenance.admission_generation`，由 1047 写方盖上）与
//     当前 generation 不一致 ⇒ stale_admission；观察值缺省 = 不比对
//     该维度（仍做 suspended/withdrawn 校验）。
//   - legacy 组（无 lifecycle 行）不阻断（§3.3 同源：无 lifecycle = 未接线面）。
//
// 原子提交（§11「receipt + 学习结算 + effective head + outbox 同事务原子」）：
//   - 结算经注入端口 `LearningSettlementPort`（YUK-1047 evaluator convergence
//     的落点；本 lane 不实现 —— blockedBy: YUK-1047）；
//   - 端口返回的 effect 处置（applied/ineligible/failed_pending）写进
//     `experimental:assessment_activation` 事件 —— receipt 即事件载荷
//     （schema 无独立 receipt 表；event 行承担 raw receipt，§11「可选 effect
//     receipt 不得被吞」⇒ 已执行激活的三种处置均留痕；未执行的尝试
//     not_completed/head_missing/stale_admission/settlement_unavailable
//     不产 receipt）；
//   - head UPDATE 带 expected CAS 谓词做 DB 层兜底（锁内已判，双保险）；
//   - outbox = 本事件行本身（event 行 + 订阅链即本仓 outbox 形态，见
//     verify-dispatch-outbox.ts 先例）。
//
// 生成单调（generation +1）、ABA 防线（expected_effective_id null-or-id
// REQUIRED + expected_generation REQUIRED，契约见 core/schema/assessment/
// ids.ts `ActivateEvaluationIntent`）原样执行。
//
// 明示缺口（与 owner 裁决一致地挂账，而非假装已交付）：
//   - 学习结算实现 = YUK-1047 seam（本模块只定义端口与调用点）；
//   - 「不可变 digest」在 assessment 侧的可执行面 = 坐标一致性
//     （submission↔issuance↔revision↔evaluation 复合坐标）；内容 digest
//     重算（plan_digest vs execution_plan）属 evaluator 写方（1047）语义；
//   - 同 coarse 不同分值的 meaningful replacement：由 aggregate 表达差异，
//     本编排不识别分值语义 —— 1047 结算端口负责判定；
//   - regrade/appeal 的学习效应政策（「regrade 不算额外练习」「不静默覆盖
//     用户已确认评级」）同样落在结算端口内部。
// ====================================================================

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type {
  EvaluationGroupIdT,
  EvaluationIdT,
  IssuanceIdT,
  RevisionIdT,
  SubmissionIdT,
} from '@/core/schema/assessment/ids';
import { ActivateEvaluationIntent, resolveActivationCas } from '@/core/schema/assessment/ids';
import type { EvaluationRecordT } from '@/core/schema/assessment/judgment';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';

/** receipt 事件 action 名。 */
export const ASSESSMENT_ACTIVATION_ACTION = 'experimental:assessment_activation';
export const ASSESSMENT_ACTIVATION_VERSION = 1 as const;

// ---------- 端口与错误 ----------

/**
 * 学习结算处置（§11「可选 effect receipt」三种落地值）。
 *   - applied：学习态（FSRS/θ̂/calibration）已在本事务内写入；
 *   - ineligible：该 evaluation 依政策不产生学习效应（candidate 仍可生效 ——
 *     effective head 前移，receipt 如实记 ineligible）；
 *   - failed_pending：结算未能完成但激活本身有效 —— head 前移 + receipt 记
 *     failed_pending，由上游 replay/重试消费（绝不静默吞掉）。
 */
export type ActivationEffect = 'applied' | 'ineligible' | 'failed_pending';

export interface ActivationSettleInput {
  tx: Tx;
  /** 锁内读出的已校验上下文（不可变输入）。 */
  evaluation: typeof evaluation.$inferSelect;
  submission: typeof assessment_submission.$inferSelect;
  head: typeof evaluation_effective_head.$inferSelect;
  issuance: typeof assessment_issuance.$inferSelect;
  /** 组根 question id（question_revision.group_id）。 */
  questionGroupId: string;
  now: Date;
}

/**
 * 学习结算注入端口（YUK-1047 接缝）：在 activation 事务内执行 FSRS/θ̂/
 * calibration 写入并返回处置。实现者必须【只用 tx 写学习态、不调模型、不
 * 另开事务】。未提供时默认 fail-closed（抛 ActivationSettlementUnavailable
 * ⇒ 全事务回滚，head 不前移、无 receipt —— 绝不假装已结算）。
 */
export type LearningSettlementPort = (input: ActivationSettleInput) => Promise<ActivationEffect>;

export class ActivationSettlementUnavailable extends Error {
  constructor() {
    super(
      'activateEvaluation: no LearningSettlementPort provided — learning settlement ' +
        'wiring is owned by YUK-1047; refusing to activate without it (fail-closed)',
    );
    this.name = 'ActivationSettlementUnavailable';
  }
}

export const settlementUnavailable: LearningSettlementPort = () => {
  throw new ActivationSettlementUnavailable();
};

// ---------- 输入契约（zod 沿用 REQUIRED-null CAS 语义） ----------

export const ActivateEvaluationRequest = ActivateEvaluationIntent.extend({
  /**
   * 评估时观察到的 admission generation（§3.3「旧验证不能改变较新
   * admission 决定」的对偶面：旧评估不能盖过新 admission）。缺省则回退读
   * `evaluation.provenance.admission_generation`；两者都缺 = 不校验该维度。
   */
  admission_generation_observed: z.number().int().min(0).optional(),
});
export type ActivateEvaluationRequestT = z.infer<typeof ActivateEvaluationRequest>;

/** 结构化结果。CAS 冲突值原样透传 core `resolveActivationCas` 判定。 */
export type ActivateEvaluationResult =
  | { status: 'activated'; effect: ActivationEffect; generation: number }
  | { status: 'already_effective'; effect: 'idempotent_replay'; generation: number }
  | {
      status:
        | 'not_found'
        | 'not_completed'
        | 'head_missing'
        | 'coordinate_mismatch'
        | 'stale_admission';
    }
  | { status: 'cas_conflict'; conflict: 'stale_head' | 'generation_mismatch' };

// ---------- 初始 head（submission/group seam 的同事务原子件） ----------

/**
 * 建 submission/group 时【同事务】插入初始 head 行（§11 首条不变量）。
 * 调用方（1047 的 saveSubmission seam / 测试）必须在自己的事务里调用 ——
 * 本函数不自带事务，保证「submission + group + head」单事务原子。
 */
export async function insertInitialEvaluationHead(
  tx: Tx,
  input: { evaluation_group_id: EvaluationGroupIdT; submission_id: SubmissionIdT; now?: Date },
): Promise<void> {
  await tx.insert(evaluation_effective_head).values({
    evaluation_group_id: input.evaluation_group_id,
    submission_id: input.submission_id,
    effective_evaluation_id: null,
    generation: 0,
    updated_at: input.now ?? new Date(),
  });
}

// ---------- 编排主体 ----------

export async function activateEvaluation(
  tx: Tx,
  rawInput: ActivateEvaluationRequestT,
  options: { settle?: LearningSettlementPort; actorRef?: string; now?: Date } = {},
): Promise<ActivateEvaluationResult> {
  const input = ActivateEvaluationRequest.parse(rawInput);
  const settle = options.settle ?? settlementUnavailable;
  const now = options.now ?? new Date();
  const actorRef = options.actorRef ?? 'assessment:activate';

  // 1) common learning-write lock（锁序第一步）。
  await acquireLearningStateWriteLock(tx);

  // 2) candidate evaluation 行锁 + 读（先取 opaque id 拿 submission/group
  //    坐标）。
  const [cand] = await tx
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, input.evaluation_id))
    .for('update')
    .limit(1);
  if (!cand) return { status: 'not_found' };
  if (cand.status !== 'completed') return { status: 'not_completed' };

  // 3) submission 行锁 + 坐标核对（复合 FK 之外的应用层兜底）。
  const [sub] = await tx
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, cand.submission_id))
    .for('update')
    .limit(1);
  if (!sub) return { status: 'not_found' };
  if (sub.evaluation_group_id !== cand.evaluation_group_id) {
    return { status: 'coordinate_mismatch' };
  }

  // 4) head 行锁（CAS 串行化点）。
  const [head] = await tx
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, cand.evaluation_group_id))
    .for('update')
    .limit(1);
  if (!head) return { status: 'head_missing' };
  if (head.submission_id !== sub.submission_id) return { status: 'coordinate_mismatch' };

  // 5) 幂等重放：candidate 已是当前 effective ⇒ 已结算过，如实返回不重写。
  const cas = resolveActivationCas(
    {
      evaluation_group_id: head.evaluation_group_id,
      submission_id: head.submission_id,
      effective_evaluation_id: head.effective_evaluation_id,
      generation: head.generation,
    },
    {
      evaluation_id: input.evaluation_id,
      expected_effective_id: input.expected_effective_id,
      expected_generation: input.expected_generation,
    },
  );
  if (!cas.ok) {
    if (cas.conflict === 'already_effective') {
      // 幂等重放：candidate 已是当前 effective ⇒ 已结算过，如实返回不重写。
      return {
        status: 'already_effective',
        effect: 'idempotent_replay',
        generation: head.generation,
      };
    }
    return { status: 'cas_conflict', conflict: cas.conflict };
  }

  // 6) 组根行锁 + admission 校验（§3.3：activation 重核 admission generation；
  //    suspended/withdrawn 组不得生效评估）。
  const [issuance] = await tx
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, sub.issuance_id))
    .limit(1);
  if (!issuance || issuance.revision_id !== sub.revision_id) {
    return { status: 'coordinate_mismatch' };
  }

  const [revRow] = await tx
    .select({ group_id: question_revision.group_id })
    .from(question_revision)
    .where(eq(question_revision.revision_id, sub.revision_id))
    .limit(1);
  if (!revRow) return { status: 'not_found' };
  const questionGroupId = revRow.group_id;

  // 组根行锁 —— 与 publish/verify 生命周期写互斥的线性化点。
  await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, questionGroupId))
    .for('update')
    .limit(1);

  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, questionGroupId))
    .limit(1);

  const provenanceGeneration =
    typeof cand.provenance?.admission_generation === 'number'
      ? cand.provenance.admission_generation
      : undefined;
  const observedGeneration = input.admission_generation_observed ?? provenanceGeneration;
  if (lifecycle) {
    if (lifecycle.suspended || lifecycle.withdrawn) return { status: 'stale_admission' };
    if (
      observedGeneration !== undefined &&
      lifecycle.scoring_admission_generation !== observedGeneration
    ) {
      return { status: 'stale_admission' };
    }
  }

  // 7) 结算（注入端口；1047 落点）→ head CAS 前移 → receipt 事件，单事务原子。
  const effect = await settle({
    tx,
    evaluation: cand,
    submission: sub,
    head,
    issuance,
    questionGroupId,
    now,
  });

  const nextGeneration = head.generation + 1;
  await tx
    .update(evaluation_effective_head)
    .set({
      effective_evaluation_id: cand.evaluation_id,
      generation: nextGeneration,
      updated_at: now,
    })
    .where(
      and(
        eq(evaluation_effective_head.evaluation_group_id, head.evaluation_group_id),
        // DB 层 CAS 兜底：锁内已判，此处防锁外写者。
        input.expected_effective_id === null
          ? isNull(evaluation_effective_head.effective_evaluation_id)
          : eq(evaluation_effective_head.effective_evaluation_id, input.expected_effective_id),
        eq(evaluation_effective_head.generation, input.expected_generation),
      ),
    );

  await writeEvent(tx, {
    id: `evt_act_${createId()}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: actorRef,
    action: ASSESSMENT_ACTIVATION_ACTION,
    subject_kind: 'evaluation_group',
    subject_id: cand.evaluation_group_id,
    outcome: 'success',
    payload: {
      version: ASSESSMENT_ACTIVATION_VERSION,
      evaluation_id: cand.evaluation_id,
      submission_id: sub.submission_id,
      issuance_id: sub.issuance_id,
      revision_id: sub.revision_id,
      question_group_id: questionGroupId,
      expected_effective_id: input.expected_effective_id,
      effective_evaluation_id: cand.evaluation_id,
      generation: nextGeneration,
      effect,
      attempt: cand.attempt,
    } satisfies Record<string, unknown>,
  });

  return { status: 'activated', effect, generation: nextGeneration };
}

// ---------- 一次性 claim 到期释放（§3.3「claim 到期恢复不得复活被撤回题」） ----------

/**
 * 释放已占用的 issuance claim（claim_status: claimed → released）。
 *
 * 本函数【只】碰 claim 生命周期列（绑定列由 trigger 冻结），不触碰
 * question/lifecycle —— 题被 verify 撤回后的 lifecycle.suspended 原样保留；
 * 释放出的 issuance 再次走发题读面时由 contract 准入门拦截，不复活撤回题
 * （§3.3）。非 'claimed' 行返回 { released: false }（unclaimed/released 恒
 * 不改动）。
 */
export async function releaseIssuanceClaim(
  tx: Tx,
  issuanceId: IssuanceIdT,
): Promise<{ released: boolean }> {
  const rows = await tx
    .update(assessment_issuance)
    .set({ claim_status: 'released', claimed_by_ref: null })
    .where(
      and(
        eq(assessment_issuance.issuance_id, issuanceId),
        eq(assessment_issuance.claim_status, 'claimed'),
      ),
    )
    .returning({ issuance_id: assessment_issuance.issuance_id });
  return { released: rows.length > 0 };
}

// ---------- 类型再导出（调用方不需要深入 core 文件） ----------

export type {
  EvaluationGroupIdT,
  EvaluationIdT,
  EvaluationRecordT,
  IssuanceIdT,
  RevisionIdT,
  SubmissionIdT,
};
