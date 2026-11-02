// Lifecycle publish for a source-verify or owner-override verdict.
//
// Admission, suspension, verification and availability move together.
// Frozen content is sent back unchanged. The caller freezes revision and
// admission generation before any paid work; this compares them under the
// group lock and rolls the caller transaction back on drift.

import { eq } from 'drizzle-orm';

import { QUESTION_AVAILABILITY } from '@/core/schema/assessment/lifecycle';
import type { Tx } from '@/db/client';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import {
  type AdmissionVerificationWrite,
  type PublishAdmission,
  type PublishQuestionGroupResult,
  type SuspensionUpdate,
  archiveGroupLifecycle,
  loadQuestionGroupContractSnapshot,
  publishQuestionGroup,
  publishQuestionGroupFromRow,
} from '@/kernel/records/assessment-publication';

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
      const { getR2 } = await import('@/kernel/object-storage');
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
