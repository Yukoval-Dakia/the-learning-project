// YUK-1043 — 统一发布链 · publisher（grounding §3.1/§3.3、§4.3 Interface）。
//
// 单一 seam：工作副本编辑 → 原子发布。一次事务内完成：
//   1. 新 question_revision（不可变；唯一键 (group_id, revision_ordinal)）；
//   2. question_group_lifecycle current pointer + §3.3 维度（availability /
//      scoring admission + generation / claim policy / suspension / withdrawal）；
//   3. experimental:assessment_publish 发布事件（ADR-0006 v2 explore 命名空间，
//      payload 松守；稳定后 promote）。
// 任一步失败 ⇒ 整体回滚（db.transaction；传 Tx 时退化为 SAVEPOINT，外层
// 回滚仍整体丢弃 —— publisher 永不跨事务）。
//
// 内容与 §3.3 生命周期维度【各自独立版本化】：digest 与当前版一致时不铸新
// revision；但请求的 admission/availability/claimPolicy 与当前 lifecycle 不一致时
// 只更新维度（admission generation+1）+ 事件，返回 'admission_updated' —— 这是
// promote/挂起类路径的落点（内容未变、资格变了）。全一致才是真 noop。
//
// group 约定（§3.1「physical question 行保留现有 ID」）：单题 = 1-part 组，
// group_id = 该 question.id；composite part（parent_question_id 非空）的组 =
// 父 question.id。legacy `question` 行是工作副本 + 读投影 —— publisher 不重写
// 其内容列（编辑方已写）；dual existence 直到 cutover（YUK-1059）。
//
// CAS：expectedCurrentRevision 必填 null-or-id（与 §4.3/§11 的
// expected_effective_id 同律 —— 禁止省略当无条件覆盖）。并发发布/编辑用
// 根 question 行 + lifecycle 行的 SELECT ... FOR UPDATE 串行化（锁序：
// question → lifecycle，发布/编辑双方一致）。
//
// Claim/lifecycle 分离（§3.2）：live 去重 claim = legacy
// canonical_content_hash 部分唯一索引（archive 置 NULL 释放、restore 原子重取
// —— 见 archiveGroupLifecycle/restoreGroupLifecycle）；lifecycle 只承载政策与
// 挂起/撤回维度，不持有去重键 —— 两者独立版本化。
//
// Admission（§3.3 / D1）：admitted 必须带 evidence + decided_at（DB CHECK
// question_group_lifecycle_admission_branch_ck）；withheld 必须带 reason。
// 未核验的 model 规则保持 withheld —— 本 lane 的 normalizer 对未准入 judge
// kind 只发 human_review executor，不冒充自动判分能力。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

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
import type { Db, Tx } from '@/db/client';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { normalizeQuestionGroupToContract } from './contract-normalizer';

export const ASSESSMENT_PUBLISH_ACTION = 'experimental:assessment_publish' as const;

/** §3.3 withheld 原因（与 lifecycle CHECK 枚举一致）。 */
export type WithheldReason =
  | 'unverified_rules'
  | 'verification_failed'
  | 'no_admitted_executor'
  | 'owner_hold';

export interface PublishAdmission {
  state: 'admitted' | 'withheld';
  /** admitted 必填（D1 双门证据）。 */
  evidence?: AdmissionEvidenceT | null;
  /** withheld 必填。 */
  reason?: WithheldReason;
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
  availability: 'general_pool' | 'container_only';
  admission: PublishAdmission;
  actorRef: string;
  claimPolicy?: 'one_time' | 'unbounded';
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
    }
  | {
      /** 内容未变但 §3.3 维度变了（promote/挂起等）：只更新 lifecycle 维度
       * （generation+1）+ 事件，不铸新 revision —— admission 与内容各自独立版本化。 */
      status: 'admission_updated';
      group_id: string;
      current_revision_id: string;
      admission_generation: number;
      event_id: string;
    }
  | { status: 'noop'; group_id: string; current_revision_id: string; reason: 'digest_unchanged' }
  | { status: 'conflict'; group_id: string; current_revision_id: string | null };

function assertAdmissionShape(admission: PublishAdmission): void {
  if (admission.state === 'admitted') {
    if (admission.evidence == null) {
      throw new Error('publishQuestionGroup: admitted requires evidence (D1 dual-gate)');
    }
    return;
  }
  if (admission.reason == null) {
    throw new Error('publishQuestionGroup: withheld requires a reason (lifecycle branch CHECK)');
  }
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
  if (input.admission.state === 'admitted') {
    return (
      lifecycle.scoring_admission_state === 'admitted' &&
      stableStringify(input.admission.evidence ?? null) ===
        stableStringify(lifecycle.scoring_admission_evidence ?? null)
    );
  }
  return (
    lifecycle.scoring_admission_state === 'withheld' &&
    lifecycle.scoring_admission_withheld_reason === input.admission.reason
  );
}

/**
 * 统一发布 seam。db 可传事务句柄（推荐 —— 与调用方的编辑写同事务）或独立
 * Db（publisher 自开顶层事务）。契约校验失败抛错（fail-closed）；CAS 不匹配
 * 返回 'conflict'；digest 与当前版一致且 §3.3 维度也一致返回 'noop'（不产生
 * 版本 churn）；digest 一致但维度变化返回 'admission_updated'（只更新 lifecycle
 * 维度 + generation，不铸新 revision）。
 */
export async function publishQuestionGroup(
  db: Db | Tx,
  input: PublishQuestionGroupInput,
): Promise<PublishQuestionGroupResult> {
  assertAdmissionShape(input.admission);

  // Db → 顶层事务；Tx → SAVEPOINT（drizzle 嵌套事务）。两种情况下任一步
  // 失败都整体回滚本次发布的全部写入。
  return db.transaction(async (tx) => {
    const { contract, group_id: groupId } = input;

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

    // CAS（REQUIRED null-or-id —— 与调用方期望不符即冲突，不静默覆盖）。
    if (input.expectedCurrentRevision !== currentRevisionId) {
      return { status: 'conflict', group_id: groupId, current_revision_id: currentRevisionId };
    }

    // Digest 去重 + §3.3 维度分离：内容与当前版一致时不铸新版本（identity/churn
    // 纪律）；但 admission/availability/claimPolicy 是独立版本化的生命周期维度 ——
    // 不一致时只更新维度（generation+1）+ 事件（promote 即此路径：草稿首版
    // withheld/unverified_rules → 核验通过后 admitted，内容未变）。
    let nextOrdinal = 1;
    if (currentRevisionId != null) {
      const [current] = await tx
        .select({
          ordinal: question_revision.revision_ordinal,
          digest: question_revision.integrity_digest,
        })
        .from(question_revision)
        .where(eq(question_revision.revision_id, currentRevisionId))
        .limit(1);
      if (current?.digest === contract.integrity_digest) {
        if (lifecycleDimensionsMatch(lifecycle, input)) {
          return {
            status: 'noop',
            group_id: groupId,
            current_revision_id: currentRevisionId,
            reason: 'digest_unchanged',
          };
        }
        const admissionGeneration = lifecycle.scoring_admission_generation + 1;
        const admissionValues =
          input.admission.state === 'admitted'
            ? {
                scoring_admission_state: 'admitted' as const,
                scoring_admission_evidence: input.admission.evidence ?? null,
                scoring_admission_withheld_reason: null,
                scoring_admission_decided_at: input.now,
              }
            : {
                scoring_admission_state: 'withheld' as const,
                scoring_admission_evidence: null,
                scoring_admission_withheld_reason: input.admission.reason ?? 'owner_hold',
                scoring_admission_decided_at: null,
              };
        await tx
          .update(question_group_lifecycle)
          .set({
            availability: input.availability,
            ...admissionValues,
            scoring_admission_generation: admissionGeneration,
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
          },
          created_at: input.now,
        });
        return {
          status: 'admission_updated',
          group_id: groupId,
          current_revision_id: currentRevisionId,
          admission_generation: admissionGeneration,
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
    const admissionValues =
      input.admission.state === 'admitted'
        ? {
            scoring_admission_state: 'admitted' as const,
            scoring_admission_evidence: input.admission.evidence ?? null,
            scoring_admission_withheld_reason: null,
            scoring_admission_decided_at: input.now,
          }
        : {
            scoring_admission_state: 'withheld' as const,
            scoring_admission_evidence: null,
            scoring_admission_withheld_reason: input.admission.reason ?? 'owner_hold',
            scoring_admission_decided_at: null,
          };

    if (lifecycle) {
      await tx
        .update(question_group_lifecycle)
        .set({
          current_revision_id: revisionId,
          availability: input.availability,
          ...admissionValues,
          scoring_admission_generation: admissionGeneration,
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
        suspended: false,
        suspension_reason: null,
        withdrawn: false,
        withdrawn_at: null,
        created_at: input.now,
        updated_at: input.now,
      });
    }

    // 发布事件（同事务）。experimental 命名空间 payload 松守（ADR-0006 v2）。
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
      },
      created_at: input.now,
    });

    return {
      status: 'published',
      revision_id: revisionId,
      revision_ordinal: nextOrdinal,
      group_id: groupId,
      event_id: eventId,
      admission_generation: admissionGeneration,
    };
  });
}

// ─── 从 legacy 行发布（加载 + 归一 + 发布 的便捷 seam） ─────

export interface PublishFromRowInput {
  /** 组根 question id（单题 = 自身；part 编辑时传父 id）。 */
  rootId: string;
  /** 缺省 preserve：沿用当前 lifecycle 的 admission（未发布过 ⇒ withheld/unverified_rules）。 */
  admission?: PublishAdmission | { state: 'preserve' };
  availability?: 'general_pool' | 'container_only';
  actorRef: string;
  now: Date;
}

/**
 * 加载组根 + 物理 parts（parent_question_id 子行，按 part_index）→ 归一 → 发布。
 * expectedCurrentRevision 由 publisher 内部读取的当前 lifecycle 决定（发布方
 * 不传期望 —— 本 seam 的 CAS 保护对象是【并发发布互斥】（行锁 + FOR UPDATE
 * lifecycle），编辑侧的乐观锁由 editQuestion 自己的 version 谓词承担）。
 */
export async function publishQuestionGroupFromRow(
  db: Db | Tx,
  input: PublishFromRowInput,
): Promise<PublishQuestionGroupResult> {
  return db.transaction(async (tx) => {
    const [root] = await tx.select().from(question).where(eq(question.id, input.rootId)).limit(1);
    if (!root) {
      throw new Error(`publishQuestionGroupFromRow: root question '${input.rootId}' not found`);
    }
    const partRows = await tx
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        reference_md: question.reference_md,
        choices_md: question.choices_md,
      })
      .from(question)
      .where(eq(question.parent_question_id, input.rootId))
      .orderBy(question.part_index);

    const contract = normalizeQuestionGroupToContract(
      root as Parameters<typeof normalizeQuestionGroupToContract>[0],
      partRows,
    );

    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, input.rootId))
      .limit(1);
    const expected = lifecycle?.current_revision_id ?? null;

    let admission: PublishAdmission;
    if (!input.admission || input.admission.state === 'preserve') {
      admission =
        lifecycle?.scoring_admission_state === 'admitted'
          ? {
              state: 'admitted',
              evidence: lifecycle.scoring_admission_evidence ?? null,
            }
          : { state: 'withheld', reason: 'unverified_rules' };
    } else {
      admission = input.admission;
    }

    return publishQuestionGroup(tx, {
      group_id: input.rootId,
      contract,
      expectedCurrentRevision: expected,
      availability:
        input.availability ??
        lifecycle?.availability ??
        (root.source === 'web_sourced' || root.source === 'quiz_gen'
          ? 'general_pool'
          : 'container_only'),
      admission,
      actorRef: input.actorRef,
      now: input.now,
    });
  });
}

// ─── lifecycle 维度操作（archive/restore 的 claim 分离语义，§3.2/§3.3） ─────

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
 */
export async function restoreGroupLifecycle(
  tx: Tx,
  groupId: string,
  canonicalContentHash: string | null,
  now: Date,
): Promise<RestoreGroupLifecycleResult> {
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
