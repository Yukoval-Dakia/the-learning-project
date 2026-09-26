// ====================================================================
// YUK-1052 — saveSubmission / saveResponseDraft / pending 恢复（grounding
// §4.3 Interface + D5/D11 + §7.3 UI 状态纪律）
// ====================================================================
//
// 本模块承载【作答持久化】三个动作：
//
//   1. saveResponseDraft(issuance_id, evaluation_group_ref?, response_set,
//      group_evidence?, expected_save_epoch?) —— D11 服务端自动保存。每
//      issuance 一行 live draft（upsert 覆盖 mutable 行），ack = 落库成功；
//      客户端 saving/saved/error 只看本函数返回值（服务端 ack 才恢复 promise）。
//      expected_save_epoch 是给前端的 stale 防线：带上次 ack 的 epoch 重存时
//      若服务端已有更新的草稿 ⇒ stale_draft（不静默盖掉别人的新作答）。
//
//   2. saveSubmission(issuance_id, evaluation_group_id, idempotency_key,
//      response_set, group_evidence?) —— §4.3 Interface 正式提交。
//      幂等（同 (evaluation_group_id, idempotency_key)）：payload 逐字一致 ⇒
//      replayed（不重写、不重复学习效应、不污染 group.submission_ids）；
//      不同 ⇒ conflict（revision/issuance/group/response 不一致的显式分支，
//      绝不覆盖已接收作答）。submission 的 revision/issuance 冗余坐标由复合
//      FK 冻结在 issuance 行 —— 提交【绝不】回取 latest revision。
//      单事务原子：evaluation_group upsert → assessment_submission 不可变行 →
//      初始 evaluation_effective_head（§11）→ 对应草稿清除 → 提交事件。
//
//   3. getIssuanceState / listResponseDraftsByGroup —— pending 恢复读面：
//      issuance + 最新 draft（null = 服务端无未保存草稿）+ 已接收提交摘要。
//
// 判定纪律：
//   - draft/submission 的 response_set 只校验【本次 issuance 发出范围内】的
//     槽位（scopeResponseSpec + issuance.part_ids）—— 引用未发出槽位 ⇒
//     invalid_response，拒收；
//   - 提交时 admission/claim 状态不再复核（§3.3：已接收作答守恒 —— 挂起后
//     提交仍接收并持久化证据，pending review 交给评估/激活层判定）；
//   - 草稿只属于 mutable 层：绝不代表已接收作答，D5 守恒只发生在
//     assessment_submission 落库那一下 ack。
//
// 锁序（固定，无环）：issuance 行 → evaluation_group 行 → draft 行。
// ====================================================================

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, isNull, or } from 'drizzle-orm';

import {
  type AssessmentIssuanceT,
  type EvaluationGroupIdT,
  type GroupEvidenceT,
  type IssuanceIdT,
  ResponseSet,
  type ResponseSetT,
  type ResponseSpecT,
  type RevisionIdT,
  type SubmissionIdT,
  type SubmissionRecordT,
  resolveSubmissionIdempotency,
  scopeResponseSpec,
  validateResponseSet,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_response_draft,
  assessment_submission,
  evaluation_effective_head,
  evaluation_group,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { insertInitialEvaluationHead } from './activate';

/** 提交 receipt 事件 action 名。 */
export const ASSESSMENT_SUBMISSION_ACTION = 'experimental:assessment_submission';
export const ASSESSMENT_SUBMISSION_VERSION = 1 as const;

// ---------- 请求契约 ----------

export interface SaveResponseDraftRequest {
  issuance_id: IssuanceIdT;
  /** 草稿声明的联合判分组锚点（paper 联判共享；null/缺省 = 未定组）。 */
  evaluation_group_ref?: EvaluationGroupIdT | null;
  response_set: ResponseSetT;
  group_evidence?: GroupEvidenceT[];
  /**
   * 客户端上次 ack 拿到的 save_epoch（stale 防线）：带上它重存时若服务端
   * 草稿 epoch 已更大 ⇒ stale_draft（拒收，防止旧客户端盖掉新作答）。
   */
  expected_save_epoch?: number;
  now?: Date;
}

export type SaveResponseDraftResult =
  | {
      status: 'saved';
      issuance_id: IssuanceIdT;
      save_epoch: number;
      updated_at: string;
    }
  | {
      status:
        | 'issuance_not_found'
        | 'invalid_response' // response_set 对发出 spec 结构非法
        | 'stale_draft'; // expected_save_epoch 落后于服务端
      issues?: string[];
      current_save_epoch?: number;
    };

export interface SaveSubmissionRequest {
  issuance_id: IssuanceIdT;
  evaluation_group_id: EvaluationGroupIdT;
  /** 幂等键：同 (group, key) 重复提交 —— payload 一致 replay；不同 conflict。 */
  idempotency_key: string;
  response_set: ResponseSetT;
  group_evidence?: GroupEvidenceT[];
  /** 客户端指定 submission_id（重试幂等锚）；缺省服务端生成。 */
  submission_id?: SubmissionIdT;
  /** 事件 actor_ref；缺省 'assessment:submit'。 */
  actorRef?: string;
  now?: Date;
}

export type SaveSubmissionResult =
  | {
      status: 'saved' | 'replayed';
      submission: SubmissionRecordT;
      /** 提交绑定的不可变坐标（冻结在 issuance 行）。 */
      revision_id: RevisionIdT;
      issuance_id: IssuanceIdT;
    }
  | {
      status:
        | 'issuance_not_found'
        | 'revision_not_found'
        | 'invalid_response'
        | 'group_conflict' // 同 submission_id 已属于另一个 group
        | 'idempotency_conflict'; // 同 key 不同 payload / 同 id 不同 key
      issues?: string[];
      /** conflict 时如实给出已存在行的关键坐标（供调用方定位）。 */
      existing_submission_id?: SubmissionIdT;
      conflict_reason?: string;
    };

export interface IssuanceState {
  issuance: AssessmentIssuanceT | null;
  /** 最新 live draft；无 = null（客户端据此恢复 pending 作答 promise）。 */
  draft: {
    response_set: ResponseSetT;
    group_evidence: GroupEvidenceT[];
    evaluation_group_ref: EvaluationGroupIdT | null;
    save_epoch: number;
    updated_at: string;
  } | null;
  /** 本 issuance 已接收的提交（恢复 UI 显示“已提交”锚点）。 */
  submissions: Array<{
    submission_id: SubmissionIdT;
    evaluation_group_id: EvaluationGroupIdT;
    submitted_at: string;
  }>;
}

// ---------- 内部工具 ----------

/** 共享的 response_set 结构校验（draft/submission 同口径：只看发出范围）。 */
function validateIssuedResponseSet(
  responseSpec: ResponseSpecT,
  issuedPartIds: readonly string[],
  responseSet: ResponseSetT,
): string[] {
  // zod 形状先过（缺字段/错类型/非法 kind 的畸形 entry 先被拦下，不落到
  // 引用级校验 —— 后者假定 entry 已具备判别式形状）。
  const parsed = ResponseSet.safeParse(responseSet);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `schema_invalid(${issue.path.join('.')}: ${issue.message})`,
    );
  }
  const scoped = scopeResponseSpec(responseSpec, issuedPartIds);
  return validateResponseSet(scoped, parsed.data).map((issue) => `${issue.code}(${issue.detail})`);
}

function toRecord(row: typeof assessment_submission.$inferSelect): SubmissionRecordT {
  return {
    submission_id: row.submission_id,
    issuance_id: row.issuance_id,
    revision_id: row.revision_id,
    evaluation_group_id: row.evaluation_group_id,
    response_set: row.response_set,
    group_evidence: row.group_evidence,
    idempotency_key: row.idempotency_key,
    submitted_at: row.submitted_at.toISOString(),
  };
}

// ---------- 1. 自动保存草稿（D11） ----------

/**
 * upsert 单发题 live draft。锁序：issuance 行 FOR UPDATE → draft upsert。
 * 服务端 ack 只在落库成功后产生 —— 客户端的 saved 状态只能来自本函数返回。
 */
export async function saveResponseDraft(
  db: Db | Tx,
  request: SaveResponseDraftRequest,
): Promise<SaveResponseDraftResult> {
  const now = request.now ?? new Date();
  return await db.transaction(async (tx) => {
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, request.issuance_id))
      .for('update')
      .limit(1);
    if (issuance == null) return { status: 'issuance_not_found' };

    // response_set 校验：只允许发出范围内的槽位（非法 ⇒ 拒收，不静默截断）。
    const [revRow] = await tx
      .select({ response_spec: question_revision.response_spec })
      .from(question_revision)
      .where(eq(question_revision.revision_id, issuance.revision_id))
      .limit(1);
    const spec = revRow?.response_spec;
    if (spec != null) {
      const issues = validateIssuedResponseSet(spec, issuance.part_ids, request.response_set);
      if (issues.length > 0) {
        return { status: 'invalid_response', issues };
      }
    }

    // stale 防线：读当前 epoch，比较 expected。
    const [existing] = await tx
      .select({ save_epoch: assessment_response_draft.save_epoch })
      .from(assessment_response_draft)
      .where(eq(assessment_response_draft.issuance_id, request.issuance_id))
      .limit(1);
    if (
      request.expected_save_epoch != null &&
      existing != null &&
      existing.save_epoch > request.expected_save_epoch
    ) {
      return { status: 'stale_draft', current_save_epoch: existing.save_epoch };
    }

    const nextEpoch = (existing?.save_epoch ?? 0) + 1;
    const groupRef = request.evaluation_group_ref ?? null;
    await tx
      .insert(assessment_response_draft)
      .values({
        issuance_id: request.issuance_id,
        evaluation_group_ref: groupRef,
        response_set: request.response_set,
        group_evidence: request.group_evidence ?? [],
        save_epoch: nextEpoch,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: assessment_response_draft.issuance_id,
        set: {
          evaluation_group_ref: groupRef,
          response_set: request.response_set,
          group_evidence: request.group_evidence ?? [],
          save_epoch: nextEpoch,
          updated_at: now,
        },
      });

    return {
      status: 'saved',
      issuance_id: request.issuance_id,
      save_epoch: nextEpoch,
      updated_at: now.toISOString(),
    };
  });
}

// ---------- 2. 正式提交（saveSubmission） ----------

/**
 * §4.3 saveSubmission：单事务原子提交。
 *
 * 次序（replay 不污染组内锚点 —— 先判幂等再改组）：
 *   1. 锁 issuance（发题事实不可变读）+ revision 快照；
 *   2. 校验 response_set 对发出 spec；
 *   3. 幂等预检：(group,key) / submission_id —— replay/conflict 直接返回，
 *      不触碰 evaluation_group.submission_ids；
 *   4. 锁 evaluation_group（同组提交串行化点）→ upsert 追加 submission_id；
 *   5. assessment_submission 不可变行；
 *   6. 初始 head（仅当组内尚无 head —— 多 submission 组锚定第一份提交，
 *      activation 的 head.submission_id 断言以该锚为准，见 activate.ts）；
 *   7. 清对应 live draft + 提交事件。
 */
export async function saveSubmission(
  db: Db | Tx,
  request: SaveSubmissionRequest,
): Promise<SaveSubmissionResult> {
  const now = request.now ?? new Date();
  const actorRef = request.actorRef ?? 'assessment:submit';

  return await db.transaction(async (tx) => {
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, request.issuance_id))
      .for('update')
      .limit(1);
    if (issuance == null) return { status: 'issuance_not_found' };
    const revisionId = issuance.revision_id;

    const [revRow] = await tx
      .select({ response_spec: question_revision.response_spec })
      .from(question_revision)
      .where(eq(question_revision.revision_id, revisionId))
      .limit(1);
    if (revRow == null) return { status: 'revision_not_found' };

    const issues = validateIssuedResponseSet(
      revRow.response_spec,
      issuance.part_ids,
      request.response_set,
    );
    if (issues.length > 0) return { status: 'invalid_response', issues };

    const submissionId = request.submission_id ?? `sub_${createId()}`;
    const groupEvidence = request.group_evidence ?? [];

    // ---- 幂等预检（先于任何组内变更：replay 不得污染 submission_ids） ----
    const [byKey] = await tx
      .select()
      .from(assessment_submission)
      .where(
        and(
          eq(assessment_submission.evaluation_group_id, request.evaluation_group_id),
          eq(assessment_submission.idempotency_key, request.idempotency_key),
        ),
      )
      .limit(1);
    const [byId] = await tx
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, submissionId))
      .limit(1);

    if (byKey != null) {
      const existing = byKey;
      // 同 (group,key) 但坐标漂移：issuance 不一致 = 另一次作答事件，显式冲突。
      if (existing.issuance_id !== request.issuance_id) {
        return {
          status: 'idempotency_conflict',
          existing_submission_id: existing.submission_id,
          conflict_reason: `issuance_mismatch: existing '${existing.issuance_id}' vs '${request.issuance_id}'`,
        };
      }
      const verdict = resolveSubmissionIdempotency(toRecord(existing), {
        submission_id: submissionId,
        issuance_id: request.issuance_id,
        revision_id: revisionId,
        evaluation_group_id: request.evaluation_group_id,
        response_set: request.response_set,
        group_evidence: groupEvidence,
        idempotency_key: request.idempotency_key,
        submitted_at: now.toISOString(),
      });
      if (verdict.outcome === 'conflict') {
        return {
          status: 'idempotency_conflict',
          existing_submission_id: existing.submission_id,
          conflict_reason: verdict.reason,
        };
      }
      // 幂等重放：返回已接收的原始提交（不重写、不重复事件/学习效应）。
      return {
        status: 'replayed',
        submission: toRecord(existing),
        revision_id: revisionId,
        issuance_id: request.issuance_id,
      };
    }
    if (byId != null) {
      // 同 submission_id 不同 (group,key)：身份碰撞，显式冲突。
      return {
        status:
          byId.evaluation_group_id !== request.evaluation_group_id
            ? 'group_conflict'
            : 'idempotency_conflict',
        existing_submission_id: byId.submission_id,
        conflict_reason:
          byId.evaluation_group_id !== request.evaluation_group_id
            ? `submission '${byId.submission_id}' already belongs to group '${byId.evaluation_group_id}'`
            : `submission '${byId.submission_id}' already exists under key '${byId.idempotency_key}'`,
      };
    }

    // ---- 组锚点（同组提交串行化点；先锁再追加） ----
    const [existingGroup] = await tx
      .select()
      .from(evaluation_group)
      .where(eq(evaluation_group.evaluation_group_id, request.evaluation_group_id))
      .for('update')
      .limit(1);
    if (existingGroup == null) {
      await tx.insert(evaluation_group).values({
        evaluation_group_id: request.evaluation_group_id,
        submission_ids: [submissionId],
        created_at: now,
      });
    } else if (!existingGroup.submission_ids.includes(submissionId)) {
      await tx
        .update(evaluation_group)
        .set({ submission_ids: [...existingGroup.submission_ids, submissionId] })
        .where(eq(evaluation_group.evaluation_group_id, request.evaluation_group_id));
    }

    // submission 不可变行（复合 FK 兜底：issuance+revision 坐标必须一致）。
    const inserted = await tx
      .insert(assessment_submission)
      .values({
        submission_id: submissionId,
        issuance_id: request.issuance_id,
        revision_id: revisionId,
        evaluation_group_id: request.evaluation_group_id,
        response_set: request.response_set,
        group_evidence: groupEvidence,
        idempotency_key: request.idempotency_key,
        submitted_at: now,
      })
      .onConflictDoNothing()
      .returning({ submission_id: assessment_submission.submission_id });
    if (inserted.length === 0) {
      // 预检后仍冲突 = 并发窗口内的真并发写入 —— 事务内可见性已保序，属
      // 不可能形状；fail-loud 绝不静默当 replay。
      throw new Error(
        `saveSubmission: '${submissionId}' conflicted after idempotency pre-check — concurrent writer outside the seam`,
      );
    }

    // 初始 head（§11 同事务原子）：组内尚无 head 才插 —— 多 submission 组锚定
    // 第一份提交；组行锁保证这里的 check-then-insert 在组内串行。
    const [head] = await tx
      .select({ evaluation_group_id: evaluation_effective_head.evaluation_group_id })
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, request.evaluation_group_id))
      .limit(1);
    if (head == null) {
      await insertInitialEvaluationHead(tx, {
        evaluation_group_id: request.evaluation_group_id,
        submission_id: submissionId,
        now,
      });
    }

    // 清对应 live draft：evaluation_group_ref 同组或未定组才删（不误删指向
    // 他组的草稿 —— 草稿是 mutable 层，提交事实不能顺手抹掉别组的）。
    await tx
      .delete(assessment_response_draft)
      .where(
        and(
          eq(assessment_response_draft.issuance_id, request.issuance_id),
          or(
            isNull(assessment_response_draft.evaluation_group_ref),
            eq(assessment_response_draft.evaluation_group_ref, request.evaluation_group_id),
          ),
        ),
      );

    await writeEvent(tx, {
      id: `evt_sub_${createId()}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: actorRef,
      action: ASSESSMENT_SUBMISSION_ACTION,
      subject_kind: 'submission',
      subject_id: submissionId,
      outcome: 'success',
      payload: {
        version: ASSESSMENT_SUBMISSION_VERSION,
        submission_id: submissionId,
        issuance_id: request.issuance_id,
        revision_id: revisionId,
        evaluation_group_id: request.evaluation_group_id,
        idempotency_key: request.idempotency_key,
        response_set: request.response_set,
        group_evidence: groupEvidence,
        submitted_at: now.toISOString(),
      } satisfies Record<string, unknown>,
      created_at: now,
    });

    return {
      status: 'saved',
      submission: {
        submission_id: submissionId,
        issuance_id: request.issuance_id,
        revision_id: revisionId,
        evaluation_group_id: request.evaluation_group_id,
        response_set: request.response_set,
        group_evidence: groupEvidence,
        idempotency_key: request.idempotency_key,
        submitted_at: now.toISOString(),
      },
      revision_id: revisionId,
      issuance_id: request.issuance_id,
    };
  });
}

// ---------- 3. pending 恢复读面 ----------

/**
 * 单发题状态快照：issuance（冻结坐标）+ live draft + 已接收提交列表。
 * 恢复 promise 的真相源 —— draft=null 即“服务器没有未保存草稿”。
 */
export async function getIssuanceState(
  db: Db | Tx,
  issuanceId: IssuanceIdT,
): Promise<IssuanceState> {
  const [issuanceRow] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, issuanceId))
    .limit(1);

  const [draftRow] = await db
    .select()
    .from(assessment_response_draft)
    .where(eq(assessment_response_draft.issuance_id, issuanceId))
    .limit(1);

  const submissions = await db
    .select({
      submission_id: assessment_submission.submission_id,
      evaluation_group_id: assessment_submission.evaluation_group_id,
      submitted_at: assessment_submission.submitted_at,
    })
    .from(assessment_submission)
    .where(eq(assessment_submission.issuance_id, issuanceId))
    .orderBy(desc(assessment_submission.submitted_at));

  return {
    issuance: issuanceRow
      ? {
          issuance_id: issuanceRow.issuance_id,
          binding: {
            revision_id: issuanceRow.revision_id,
            part_ids: issuanceRow.part_ids,
            material_bindings: issuanceRow.material_bindings,
            option_order: issuanceRow.option_order,
          },
          issued_at: issuanceRow.issued_at.toISOString(),
          claim: {
            policy: issuanceRow.claim_policy,
            status: issuanceRow.claim_status,
            claimed_by_ref: issuanceRow.claimed_by_ref ?? null,
          },
        }
      : null,
    draft: draftRow
      ? {
          response_set: draftRow.response_set,
          group_evidence: draftRow.group_evidence,
          evaluation_group_ref: draftRow.evaluation_group_ref ?? null,
          save_epoch: draftRow.save_epoch,
          updated_at: draftRow.updated_at.toISOString(),
        }
      : null,
    submissions: submissions.map((row) => ({
      submission_id: row.submission_id,
      evaluation_group_id: row.evaluation_group_id,
      submitted_at: row.submitted_at.toISOString(),
    })),
  };
}

/**
 * 联判组内全部 live draft（paper 恢复：一次取回组内多 slot 草稿）。
 * 只读；不验证组是否存在（组锚点由 saveSubmission 维护）。
 */
export async function listResponseDraftsByGroup(
  db: Db | Tx,
  evaluationGroupRef: EvaluationGroupIdT,
): Promise<
  Array<{
    issuance_id: IssuanceIdT;
    response_set: ResponseSetT;
    group_evidence: GroupEvidenceT[];
    save_epoch: number;
    updated_at: string;
  }>
> {
  const rows = await db
    .select()
    .from(assessment_response_draft)
    .where(eq(assessment_response_draft.evaluation_group_ref, evaluationGroupRef))
    .orderBy(assessment_response_draft.issuance_id);
  return rows.map((row) => ({
    issuance_id: row.issuance_id,
    response_set: row.response_set,
    group_evidence: row.group_evidence,
    save_epoch: row.save_epoch,
    updated_at: row.updated_at.toISOString(),
  }));
}

// ---------- 类型再导出（调用方不需要深入 core 文件） ----------

export type { EvaluationGroupIdT, GroupEvidenceT, IssuanceIdT, ResponseSetT, SubmissionIdT };
