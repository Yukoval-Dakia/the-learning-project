// ====================================================================
// YUK-1568 S3 — 共享 save/submit 事务内核（唯一 typed 组持久化业务实现）。
//
// 三个真实出口：
//
//   - `submitDraftQuestionInTx` —— submit 的完整事务内核：request 认领、草稿
//     行锁与 CAS、契约编码、准入判定、来源 URL claim、exact/near 去重、根
//     question 行投影、唯一 publishQuestionGroup seam、草稿终态、verify
//     outbox intent、回执事件。提交层级由 `Tx` 参数显式声明 —— 不靠
//     `Db | Tx` 猜测；嵌在外事务里时全部写入随外层原子提交/回滚。
//
//   - `persistDeclaredQuestionGroup(InTx)` —— 新组 save+submit 原子链：
//     绑定声明身份（typed-group）→ saveDraftEditInTx → submitDraftQuestionInTx
//     （producer 信任投影 + 父子行物化）在同一个最外事务里完成。Db 入口负责
//     TxAbort/SharedSubmitAbort 的事务外转换；InTx 入口供已在外事务内的
//     可信调用方。commit 后才 drain verify intent（drainSubmitVerifyIntents）。
//
//   - claim/receipt/fingerprint 原语（claimSubmitRequestId、
//     writeSubmitReceiptEvent、submitRequestFingerprint）—— candidate/compat
//     提交路径与本内核共用同一 claim 纪律与回执事件形状；回执事件 envelope
//     统一落 task_run_id。
//
// 判定逻辑（准入/判分层比对/契约屏障/presentation/来源归属/近似去重）在
// submit-decision.ts；typed 身份绑定与子行投影在 typed-group.ts。
// ====================================================================

import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  canonicalQuestionContentHash,
  claimHttpSourceDuplicate,
  mergeExactQuestionDuplicateKnowledgeIds,
} from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import { AgentRef } from '@/core/schema/business';
import {
  QuestionDraftDocument,
  type QuestionDraftDocumentT,
  draftDocumentToStructuredQuestion,
  isDraftDocumentV2,
  isLegacyStructuredQuestion,
  structuredQuestionToDraftDocument,
} from '@/core/schema/question-draft';
import type { Db, Tx } from '@/db/client';
import { question, question_block, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { publishedContractSeal } from '@/kernel/records/assessment-normalization';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/server/boss/verify-dispatch-outbox';
import { projectQuestionBlockGuarded } from '@/server/projections/question_block';
import { writeQuestionBlockLifecycleEvent } from '@/server/projections/question_block-lifecycle-event';
import {
  applyScoringEditPlan,
  draftCanonicalIdentity,
  draftDocumentToContract,
} from '@/server/questions/draft-contract';
import {
  type EditQuestionResult,
  TxAbort,
  encodeDraftRef,
  parseDraftRef,
  saveDraftEditInTx,
} from '@/server/questions/edit-question';
import { publishQuestionGroup } from '@/server/questions/publisher';
import {
  SOURCE_KIND_TO_QUESTION_SOURCE,
  admissionForContentEdit,
  attributableSourceIssue,
  canonicalJson,
  contractBarrierIssues,
  conversionWithheld,
  deriveKind,
  draftCarriesFigure,
  nearDuplicateInKnowledge,
  presentationForDraft,
  runAdmissionChecks,
} from '@/server/questions/submit-decision';
import type { SubmitDraftInput, SubmitResult } from '@/server/questions/submit-question';
import {
  TypedGroupProjectionError,
  bindDeclaredGroupIds,
  insertTypedGroupChildren,
} from '@/server/questions/typed-group';

export const DRAFT_SUBMIT_ACTION = 'experimental:question_draft_submit';

type BlockRow = typeof question_block.$inferSelect;

/** 与 submit-question.ts 既有 SubmitContext 同形（facade 委托不窄化）。 */
export interface SharedSubmitContext {
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  sessionId?: string | null;
  taskRunId?: string;
  causedByEventId?: string | null;
  now?: Date;
}

/**
 * 可信新组投影（系统侧组装；绝不暴露给模型输入）。仅新组首次提交生效。
 * 与 `sourced` 供给注入可同现（sourced 管 URL claim/dedup 指纹/路由
 * provenance 元数据，producer 管行投影覆盖与子行物化）；字段重叠时
 * producer 优先（canonicalContentHash→hashForDedup、createdBy、difficulty、
 * sourceRef、rowSource），metadata 按 sourced → producer 顺序并入。
 */
export interface TrustedNewGroupProjection {
  /** 根组真实 id（缺省由内核铸 cuid2）。 */
  newGroupId?: string;
  /** 'parent-parts'：doc.parts>1 时按声明序投影真实 question 子行。 */
  materializeParts?: 'parent-parts';
  /** 覆盖 dedup 用的内容指纹（同 sourced.canonical_content_hash 口径）。 */
  canonicalContentHash?: string;
  /** mergeExactQuestionDuplicateKnowledgeIds 的 actorRef（缺省 'sourcing'）。 */
  dedupActor?: 'quiz_gen' | 'sourcing' | 'jyeoo_fetch';
  /** question.created_by（路由 provenance ref）。 */
  createdBy?: (typeof question.$inferInsert)['created_by'];
  /** question.difficulty（缺省列默认 3）。 */
  difficulty?: number;
  /** question.source_ref 覆盖（缺省 doc.source?.ref）。 */
  sourceRef?: string | null;
  /** question.source 覆盖（缺省按 doc.source.kind 映射/旧行沿用）。 */
  rowSource?: string;
  /** 并入 question.metadata 的系统侧键（同 sourced.metadata 纪律）。 */
  metadata?: Record<string, unknown>;
  /** 供给质量闸证据（只进 request 指纹；持久化由调用方走 metadata）。 */
  qualityGate?: unknown;
  /** 真实 paid-output 身份（只进 request 指纹；持久化由调用方走 metadata）。 */
  paidOutput?: unknown;
}

export interface SharedSubmitOptions {
  producer?: TrustedNewGroupProjection;
}

/**
 * 提交阶段的终止哨兵：任何须回滚整事务的失败（投影冲突、save 失败等）
 * 以它抛出，由最外 Db 入口在事务外转换 result —— 事务里绝不吞失败。
 * stage 决定 payload 里哪个字段有效：declare→issues、save→save、
 * submit→submit。
 */
export class SharedSubmitAbort extends Error {
  constructor(
    public readonly stage: 'declare' | 'save' | 'submit',
    public readonly payload: {
      issues?: { code: string; detail: string; part_id?: string; unit_id?: string }[];
      save?: EditQuestionResult;
      submit?: SubmitResult;
    },
  ) {
    super(`shared-submit abort at ${stage}`);
    this.name = 'SharedSubmitAbort';
  }
}

/** 父子行投影失败由 typed-group 抛出 TypedGroupProjectionError —— 内核不捕获。 */

// ---------- 请求指纹 / 回执（与 save 同一幂等纪律） ----------

/**
 * 提交请求指纹：request_id 幂等重放的内容绑定。sourced/producer 两通道的
 * 身份字段进指纹；metadata/supply_trace 等簿记（含 attempt 时间戳）不进 ——
 * 同 request_id 重放必须命中同回执。
 */
export function submitRequestFingerprint(
  input: SubmitDraftInput,
  opts?: SharedSubmitOptions,
): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        draft_ref: input.draft_ref,
        expected_draft_version: input.expected_draft_version,
        expected_revision: input.expected_revision,
        knowledge_ids: input.knowledge_ids,
        availability: input.availability,
        sourced:
          input.sourced != null
            ? {
                canonical_content_hash: input.sourced.canonical_content_hash,
                created_by: input.sourced.created_by,
                difficulty: input.sourced.difficulty ?? null,
                source_claim:
                  input.sourced.source_claim != null
                    ? {
                        source_url: input.sourced.source_claim.source_url,
                        actor_ref: input.sourced.source_claim.actor_ref,
                      }
                    : null,
              }
            : null,
        producer:
          opts?.producer != null
            ? {
                new_group_id: opts.producer.newGroupId ?? null,
                materialize_parts: opts.producer.materializeParts ?? null,
                canonical_content_hash: opts.producer.canonicalContentHash ?? null,
                dedup_actor: opts.producer.dedupActor ?? null,
                created_by: opts.producer.createdBy ?? null,
                difficulty: opts.producer.difficulty ?? null,
                source_ref: opts.producer.sourceRef ?? null,
                row_source: opts.producer.rowSource ?? null,
                quality_gate: opts.producer.qualityGate ?? null,
                paid_output: opts.producer.paidOutput ?? null,
              }
            : null,
      }),
    )
    .digest('hex')}`;
}

function parseExpectedRevision(raw: string): string | null {
  const parts = raw.split(':');
  if (parts.length === 3 && parts[0] === 'qrev1') return parts[1];
  return raw;
}

function documentOfBlock(block: BlockRow): QuestionDraftDocumentT | null {
  const structured = block.structured;
  if (structured == null) return null;
  if (isDraftDocumentV2(structured)) {
    const parsed = QuestionDraftDocument.safeParse(structured);
    return parsed.success ? parsed.data : null;
  }
  if (isLegacyStructuredQuestion(structured)) {
    return structuredQuestionToDraftDocument(structured, block.figures ?? []);
  }
  return null;
}

export async function findSubmitReceipt(
  db: Db | Tx,
  requestId: string,
): Promise<{ fingerprint: string; receipt: SubmitResult } | null> {
  const { event } = await import('@/db/schema');
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, DRAFT_SUBMIT_ACTION),
        sql`${event.payload} ->> 'request_id' = ${requestId}`,
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  const payload = rows[0]?.payload as { fingerprint?: string; receipt?: SubmitResult } | undefined;
  if (payload?.fingerprint == null || payload.receipt == null) return null;
  return { fingerprint: payload.fingerprint, receipt: payload.receipt };
}

/** request_id 认领（调用方须先取 pg_advisory_xact_lock(hashtext(request_id))）。 */
export async function claimSubmitRequestId(
  tx: Tx,
  requestId: string,
  fingerprint: string,
): Promise<
  | { status: 'claimed' }
  | { status: 'replay'; receipt: SubmitResult }
  | { status: 'reused'; existing: { fingerprint: string } }
> {
  const existing = await findSubmitReceipt(tx, requestId);
  if (existing == null) return { status: 'claimed' };
  if (existing.fingerprint === fingerprint) return { status: 'replay', receipt: existing.receipt };
  return { status: 'reused', existing };
}

/** 提交回执事件：draft 提交 subject=question_block；candidate 提交 subject=question。 */
export async function writeSubmitReceiptEvent(
  tx: Tx,
  subject: { kind: 'question_block' | 'question'; id: string },
  requestId: string,
  fingerprint: string,
  receipt: SubmitResult,
  ctx: SharedSubmitContext,
  now: Date,
): Promise<void> {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
    actor_ref: ctx.actorRef,
    action: DRAFT_SUBMIT_ACTION,
    subject_kind: subject.kind,
    subject_id: subject.id,
    outcome: 'success',
    task_run_id: ctx.taskRunId ?? null,
    payload: { request_id: requestId, fingerprint, receipt },
    created_at: now,
    ingest_at: now,
  });
}

// ---------- 提交事务内核 ----------

/**
 * submitDraftQuestion 的完整业务（事务内核形态）。语义与原 Db 入口逐行一致；
 * 扩展面只有 opts.producer（可信新组投影 + 父子行物化）。
 */
export async function submitDraftQuestionInTx(
  tx: Tx,
  input: SubmitDraftInput,
  ctx: SharedSubmitContext,
  opts?: SharedSubmitOptions,
): Promise<SubmitResult> {
  const requestId = input.request_id;
  if (requestId == null || requestId.length === 0) {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: 'request_id is required for submit idempotency',
      request_id: '',
    };
  }
  const parsedRef = parseDraftRef(input.draft_ref);
  if (parsedRef == null) {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: `invalid draft_ref '${input.draft_ref}' (expected qdraft1:<block>:<version>)`,
      request_id: requestId,
    };
  }
  const expectedRevisionRaw = input.expected_revision;
  // 校验形状：qrev1:<id>:<digest> 或裸 revision_id；带 ':' 但非 qrev1 或空串
  // = malformed ⇒ reject（不是 CAS，是请求形状错误）。undefined = 待
  // doc.base.revision_id 默认填充；null = 期望组尚无已发布 revision。
  let expectedRevisionId: string | null | undefined;
  if (expectedRevisionRaw === undefined) {
    expectedRevisionId = undefined;
  } else if (expectedRevisionRaw === null) {
    expectedRevisionId = null;
  } else if (
    expectedRevisionRaw.length === 0 ||
    (expectedRevisionRaw.includes(':') && !expectedRevisionRaw.startsWith('qrev1:'))
  ) {
    return {
      status: 'conflict',
      reason: 'invalid_request',
      detail: `malformed expected_revision '${expectedRevisionRaw}' (expected qrev1:<id>:<digest> or a bare revision_id, or null)`,
      request_id: requestId,
    };
  } else {
    expectedRevisionId = parseExpectedRevision(expectedRevisionRaw);
  }
  // request_id 幂等：同 id 同内容重放返回同回执，不同内容拒绝。
  const fingerprint = submitRequestFingerprint(input, opts);
  const now = ctx.now ?? new Date();
  // request_id 认领原子化：advisory xact lock 串行化同 request_id 并发，
  // 锁内查重放（原 check-then-act 竞态在锁外）。
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
  const existing = await findSubmitReceipt(tx, requestId);
  if (existing != null) {
    if (existing.fingerprint === fingerprint) {
      return { ...(existing.receipt as SubmitResult), replayed: true };
    }
    return {
      status: 'conflict',
      reason: 'request_id_reused',
      detail: `request_id '${requestId}' was used with different content`,
      request_id: requestId,
    };
  }

  const [block] = await tx
    .select()
    .from(question_block)
    .where(eq(question_block.id, parsedRef.blockId))
    .for('update')
    .limit(1);
  if (block == null) {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: `draft '${parsedRef.blockId}' not found`,
      request_id: requestId,
    };
  }
  if (block.status !== 'draft') {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: `draft '${block.id}' status '${block.status}' (already submitted/retired)`,
      request_id: requestId,
    };
  }
  const expectedDraftVersion = input.expected_draft_version ?? parsedRef.version;
  if (block.version !== expectedDraftVersion) {
    return {
      status: 'conflict',
      reason: 'draft_version_cas',
      detail: `draft '${block.id}' version is ${block.version}, expected ${expectedDraftVersion}`,
      current_draft_ref: encodeDraftRef(block.id, block.version),
      current_draft_version: block.version,
      request_id: requestId,
    };
  }
  const doc = documentOfBlock(block);
  if (doc == null) {
    return {
      status: 'conflict',
      reason: 'not_a_draft',
      detail: `draft '${block.id}' has no v2 document or adaptable legacy tree`,
      request_id: requestId,
    };
  }
  if (input.knowledge_ids != null) doc.knowledge_ids = input.knowledge_ids;

  // 默认 CAS：draft 钉住的基底 revision 即期望值（防静默 rebase 到未读
  // 版本）。显式 expected_revision 覆盖；explicit null = 期望尚无版本。
  // base.revision_id 为 null 表示建草稿时组尚无已发布版本，必须保持 null
  // 参与比较。`?? undefined` 会把它当成「未钉住」从而关掉 CAS。
  const pinnedBaseRevision =
    doc.base == null || doc.base.revision_id === undefined ? undefined : doc.base.revision_id;
  const effectiveExpectedRevision =
    expectedRevisionId !== undefined ? expectedRevisionId : pinnedBaseRevision;

  const groupId =
    doc.base?.question_id ?? block.imported_question_id ?? opts?.producer?.newGroupId ?? createId();
  let contract = draftDocumentToContract(doc, groupId);
  const editingExisting = doc.base?.question_id != null || block.imported_question_id != null;

  // 新题的未决转换在读组之前就返回。编辑已发布题要等判分计划：原样拷贝
  // 已存层时，编码器的转换问题不代表即将发布的契约。
  if (!editingExisting && contract.conversion_issues.length > 0) {
    return conversionWithheld(contract, requestId);
  }

  // 组当前状态（CAS + lifecycle 快照；发布 seam 内部复核同一令牌）。
  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .for('update')
    .limit(1);
  const currentRevisionId = lifecycle?.current_revision_id ?? null;
  if (effectiveExpectedRevision !== undefined && effectiveExpectedRevision !== currentRevisionId) {
    return {
      status: 'conflict',
      reason: 'revision_cas',
      detail: `group '${groupId}' current revision is ${currentRevisionId ?? 'none'}, expected ${effectiveExpectedRevision ?? 'none'}`,
      current_draft_ref: encodeDraftRef(block.id, block.version),
      current_draft_version: block.version,
      current_revision_ref: currentRevisionId,
      request_id: requestId,
    };
  }

  // 判分准入钩子（调用点：dual-solve / calibration lane 在此扩展）。
  const admission = await runAdmissionChecks(tx, {
    doc,
    unitSummary: contract.unit_summary,
    knowledgeIds: doc.knowledge_ids,
    groupId,
  });
  if (admission.group_blockers.length > 0) {
    const withheld: SubmitResult = {
      status: 'withheld',
      published: false,
      detail: admission.group_blockers.map((b) => `${b.code}: ${b.detail}`).join('; '),
      issues: admission.group_blockers.map((b) => ({ code: b.code, detail: b.detail })),
      per_unit: admission.per_unit,
      request_id: requestId,
    };
    return withheld;
  }

  // ---- question 工作副本行（投影；revision 才是判分真相） ----
  const identity = draftCanonicalIdentity(doc);
  const canonicalHash = canonicalQuestionContentHash(identity);
  const structuredProjection = draftDocumentToStructuredQuestion(doc);
  const promptMd = identity.promptMd;
  const referenceMd = identity.referenceMd;
  const choicesMd = identity.choicesMd;
  // 工作副本行存在与否决定 insert vs update（lifecycle 为空 ≠ 行不存在：
  // 从未发布过的 legacy 行没有 lifecycle）。
  const [existingRow] = await tx
    .select({ id: question.id, source: question.source })
    .from(question)
    .where(eq(question.id, groupId))
    .limit(1);
  const isNew = existingRow == null;
  // 供给链系统注入只对新组首次提交有效；编辑已发布组携带它 = 调用方误用，
  // 显式冲突拒绝而不是静默丢弃系统注入（sourced-draft-insert 同款纪律）。
  if ((input.sourced != null || opts?.producer != null) && !isNew) {
    const conflict: SubmitResult = {
      status: 'conflict',
      reason: 'invalid_request',
      detail: 'sourced/producer projection is only valid for the first submit of a new group',
      request_id: requestId,
    };
    await writeSubmitReceiptEvent(
      tx,
      { kind: 'question_block', id: block.id },
      requestId,
      fingerprint,
      conflict,
      ctx,
      now,
    );
    return conflict;
  }
  const sourceIssue = await attributableSourceIssue(tx, doc, isNew);
  if (sourceIssue != null) {
    const withheld: SubmitResult = {
      status: 'withheld',
      published: false,
      detail: sourceIssue.detail,
      issues: [sourceIssue],
      per_unit: admission.per_unit,
      request_id: requestId,
    };
    return withheld;
  }
  const questionSource =
    opts?.producer?.rowSource ??
    (doc.source != null
      ? (SOURCE_KIND_TO_QUESTION_SOURCE[doc.source.kind] ?? 'quiz_gen')
      : (existingRow?.source ?? 'manual'));
  const [currentRevision] =
    currentRevisionId == null
      ? []
      : await tx
          .select({
            revision_id: question_revision.revision_id,
            group_id: question_revision.group_id,
            structure: question_revision.structure,
            response_spec: question_revision.response_spec,
            scoring_basis: question_revision.scoring_basis,
            execution_plan: question_revision.execution_plan,
            presentation: question_revision.presentation,
          })
          .from(question_revision)
          .where(eq(question_revision.revision_id, currentRevisionId))
          .limit(1);
  if (currentRevision != null) {
    const applied = applyScoringEditPlan(currentRevision, doc, contract);
    if (applied.plan.action === 'refuse') {
      return {
        status: 'withheld',
        published: false,
        detail: applied.plan.detail,
        issues: [{ code: applied.plan.code, detail: applied.plan.detail }],
        per_unit: admission.per_unit,
        request_id: requestId,
      };
    }
    contract = applied.contract;
  }
  // 未决转换 ⇒ 不铸 revision。原样拷贝已存层时转换问题已经清掉。
  // 未发布的 withheld 不写回执。确定性 request_id（proposal-submit）否则会
  // 重放这次失败，知识点恢复后 accept 仍 422。
  if (contract.conversion_issues.length > 0) {
    return conversionWithheld(contract, requestId);
  }
  const effectiveAdmission = admissionForContentEdit(
    lifecycle,
    admission,
    currentRevision ?? null,
    contract,
    doc.knowledge_ids,
  );
  const presentation = presentationForDraft(doc, contract);
  const barrierIssues = contractBarrierIssues(contract, presentation, effectiveAdmission);
  if (barrierIssues.length > 0) {
    const withheld: SubmitResult = {
      status: 'withheld',
      published: false,
      detail: barrierIssues.map((issue) => `${issue.code}: ${issue.detail}`).join('; '),
      issues: barrierIssues,
      per_unit: admission.per_unit,
      request_id: requestId,
    };
    return withheld;
  }
  const integrityDigest = publishedContractSeal({
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
    ...(presentation != null ? { presentation } : {}),
  }).canonical;
  const producer = opts?.producer;
  if (isNew) {
    // YUK-1568 S3（R1 F3）—— 一页一题来源 URL 的终态 claim 与行 INSERT
    // 同事务：pg_advisory_xact_lock 持到本事务提交，并发同 URL 候选串行化，
    // 后到者锁后重查命中本行。复用既有原语（release 终态草稿 + KC merge），
    // 命中即 duplicate_source 冲突 + 回执（不静默丢 claim）。
    if (input.sourced?.source_claim != null) {
      const claimedSource = await claimHttpSourceDuplicate(tx, {
        sourceUrl: input.sourced.source_claim.source_url,
        knowledgeIds: doc.knowledge_ids,
        actorRef: input.sourced.source_claim.actor_ref,
        taskRunId: ctx.taskRunId,
        now,
        onTerminal: 'release',
      });
      if (claimedSource != null) {
        const conflict: SubmitResult = {
          status: 'conflict',
          reason: 'duplicate_source',
          detail: `同一来源网址命中既有题 ${claimedSource.existingQuestionId}；目标 KC 已并入`,
          question_id: claimedSource.existingQuestionId,
          existing_question_id: claimedSource.existingQuestionId,
          request_id: requestId,
        };
        await writeSubmitReceiptEvent(
          tx,
          { kind: 'question_block', id: block.id },
          requestId,
          fingerprint,
          conflict,
          ctx,
          now,
        );
        return conflict;
      }
    }
    // 供给链注入的 flat 指纹优先于投影身份——与旧 flat 行同一 dedup 口径，
    // 否则选择题等投影后 reference 变化会丢失对既有行的精确去重命中。
    const hashForDedup =
      producer?.canonicalContentHash ?? input.sourced?.canonical_content_hash ?? canonicalHash;
    // live 去重 claim：canonical hash 占用者存在 ⇒ cross-KC merge（与供给
    // 链同语义）；否则插入新行。
    const merged = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
      canonicalContentHash: hashForDedup,
      knowledgeIds: doc.knowledge_ids,
      actorRef: producer?.dedupActor ?? 'sourcing',
      taskRunId: ctx.taskRunId,
      now,
    });
    const rowDifficulty = producer?.difficulty ?? input.sourced?.difficulty;
    if (merged?.disposition === 'merged') {
      const conflict: SubmitResult = {
        status: 'conflict',
        reason: 'duplicate_exact',
        detail: `canonical hash 命中既有题 ${merged.id}；目标 KC 已并入`,
        question_id: merged.id,
        existing_question_id: merged.id,
        request_id: requestId,
      };
      await writeSubmitReceiptEvent(
        tx,
        { kind: 'question_block', id: block.id },
        requestId,
        fingerprint,
        conflict,
        ctx,
        now,
      );
      return conflict;
    }
    if (!draftCarriesFigure(doc)) {
      const near = await nearDuplicateInKnowledge(
        tx,
        doc.knowledge_ids,
        promptMd,
        referenceMd,
        choicesMd,
        groupId,
      );
      if (near != null) {
        const conflict: SubmitResult = {
          status: 'conflict',
          reason: 'near_dup',
          detail: `n-gram overlap ${near.overlap.toFixed(3)}（KC 池 ${near.poolSize} 题）`,
          request_id: requestId,
        };
        await writeSubmitReceiptEvent(
          tx,
          { kind: 'question_block', id: block.id },
          requestId,
          fingerprint,
          conflict,
          ctx,
          now,
        );
        return conflict;
      }
    }
    await tx.insert(question).values({
      id: groupId,
      kind: deriveKind(doc),
      prompt_md: promptMd,
      reference_md: referenceMd,
      choices_md: choicesMd,
      knowledge_ids: doc.knowledge_ids,
      source: questionSource,
      source_ref:
        producer?.sourceRef !== undefined ? producer.sourceRef : (doc.source?.ref ?? null),
      draft_status: 'draft',
      structured: structuredProjection,
      // 供给注入的路由 provenance（SourcingTask 等 system ref）；缺省沿用
      // submit_question 自身 actor——两种都是可信系统侧写入方。
      created_by:
        producer?.createdBy ??
        input.sourced?.created_by ??
        AgentRef.parse({ by: 'ai', task_kind: 'submit_question' }),
      metadata: {
        draft_block_id: block.id,
        submit_source: doc.source ?? null,
        schema_version: 2,
        // 系统侧 provenance/供给元数据（web_sourced、difficulty_evidence、
        // 路由与候选身份、向量近重 hold 等）——同一发布事务落行，
        // source_verify 的确定性来源核对依赖它。
        ...(input.sourced?.metadata ?? {}),
        ...(producer?.metadata ?? {}),
      },
      created_at: now,
      updated_at: now,
      canonical_content_hash: hashForDedup,
      ...(rowDifficulty != null ? { difficulty: rowDifficulty } : {}),
    });
    // typed 组首发：多 part 文档在同事务投影真实子行 —— 契约 part_id 即
    // 子行 question.id（绑定器保证），parent_question_id/part_index 是唯一
    // part-ness/序权威；不逐 child FromRow 重发，发布 seam 一次覆盖全组。
    if (producer?.materializeParts === 'parent-parts' && doc.parts.length > 1) {
      await insertTypedGroupChildren(tx, {
        groupId,
        document: doc,
        now,
        knowledgeIds: doc.knowledge_ids,
        difficulty: producer.difficulty ?? input.sourced?.difficulty,
        source: questionSource,
        sourceRef:
          producer.sourceRef !== undefined ? producer.sourceRef : (doc.source?.ref ?? null),
        draftBlockId: block.id,
        producedBy: producer.createdBy ?? input.sourced?.created_by,
      });
    }
  } else {
    // 编辑已发布题：dedup hash 冲突 ⇒ conflict。
    const hashHolder = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.canonical_content_hash, canonicalHash))
      .limit(1);
    if (hashHolder[0] != null && hashHolder[0].id !== groupId) {
      return {
        status: 'conflict',
        reason: 'duplicate_exact',
        detail: `canonical hash 被 ${hashHolder[0].id} 占用`,
        existing_question_id: hashHolder[0].id,
        request_id: requestId,
      };
    }
    // 工作副本行 = 「当前已准入 revision」的投影。这次编辑不再可发时，
    // 内容列保持上一份已准入投影（未验证的新答案不进练习池），并把行标回
    // draft：练习池只认 draft_status / suspended / withdrawn，不认准入。
    // 真正 admitted 时才更新内容列。
    if (effectiveAdmission.state === 'admitted') {
      await tx
        .update(question)
        .set({
          prompt_md: promptMd,
          reference_md: referenceMd,
          choices_md: choicesMd,
          knowledge_ids: doc.knowledge_ids,
          structured: structuredProjection,
          canonical_content_hash: canonicalHash,
          kind: deriveKind(doc),
          updated_at: now,
          version: sql`${question.version} + 1`,
        })
        .where(eq(question.id, groupId));
    } else if (lifecycle?.scoring_admission_state === 'admitted') {
      await tx
        .update(question)
        .set({
          draft_status: 'draft',
          updated_at: now,
          version: sql`${question.version} + 1`,
        })
        .where(eq(question.id, groupId));
    }
  }

  // ---- 唯一发布 seam ----
  const publishResult = await publishQuestionGroup(tx, {
    group_id: groupId,
    contract: {
      structure: contract.structure,
      response_spec: contract.response_spec,
      scoring_basis: contract.scoring_basis,
      execution_plan: contract.execution_plan,
      integrity_digest: integrityDigest,
      ...(presentation != null ? { presentation } : {}),
    },
    expectedCurrentRevision: currentRevisionId,
    expectedAdmissionGeneration: lifecycle?.scoring_admission_generation ?? null,
    availability:
      input.availability ??
      lifecycle?.availability ??
      (questionSource === 'web_sourced' || questionSource === 'quiz_gen'
        ? 'general_pool'
        : 'container_only'),
    admission: effectiveAdmission,
    actorRef: `submit_question:${ctx.actorRef}`,
    publishedBy: AgentRef.parse({ by: 'ai', task_kind: 'submit_question' }),
    now,
  });
  if (publishResult.status === 'conflict') {
    return {
      status: 'conflict',
      reason: 'publish_conflict',
      detail: `publish seam conflict (${publishResult.reason})`,
      question_id: groupId,
      current_revision_ref: publishResult.current_revision_id,
      request_id: requestId,
    };
  }
  const revisionId =
    publishResult.status === 'published' || publishResult.status === 'noop'
      ? ((publishResult as { revision_id?: string }).revision_id ??
        (publishResult as { current_revision_id?: string }).current_revision_id)
      : undefined;

  // ---- 草稿终态 + verify outbox（fetch 来源） ----
  const nextBlockVersion = block.version + 1;
  await writeQuestionBlockLifecycleEvent(tx, {
    blockId: block.id,
    op: 'set_status',
    status: 'submitted',
    importedQuestionId: groupId,
    importedAttemptEventId: undefined,
    nextVersion: nextBlockVersion,
    actorKind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
    actorRef: ctx.actorRef,
    now,
  });
  await projectQuestionBlockGuarded(tx, block.id);

  let verifyEnqueued: boolean | undefined;
  const sourceKind = doc.source?.kind;
  if (sourceKind === 'jyeoo_fetch' || sourceKind === 'sourcing_web') {
    await writeVerifyDispatchIntent(tx, {
      questionId: groupId,
      verifier: 'source_verify',
      createdAt: now,
      ...(input.sourced?.supply_trace != null ? { supplyTrace: input.sourced.supply_trace } : {}),
    });
    verifyEnqueued = true;
  }

  const receipt: SubmitResult = {
    // 状态判别序：withheld（闸拒） > pending（已提交待验证） > admitted。
    status:
      effectiveAdmission.state === 'withheld'
        ? 'withheld'
        : verifyEnqueued === true
          ? 'pending'
          : 'admitted',
    question_id: groupId,
    group_id: groupId,
    ...(revisionId != null ? { revision_id: revisionId } : {}),
    ...(publishResult.status === 'published'
      ? {
          revision_ref: `qrev1:${publishResult.revision_id}:${(publishResult.revision_digest ?? '').replace('sha256:', '').slice(0, 12)}`,
          revision_ordinal: publishResult.revision_ordinal,
        }
      : {}),
    publish_status: publishResult.status,
    per_unit: admission.per_unit,
    ...(verifyEnqueued != null ? { verify_enqueued: verifyEnqueued } : {}),
    request_id: requestId,
  };
  await writeSubmitReceiptEvent(
    tx,
    { kind: 'question_block', id: block.id },
    requestId,
    fingerprint,
    receipt,
    ctx,
    now,
  );
  return receipt;
}

/**
 * 提交结果里的 source_verify intent 派发（事务外调用）。派发按「intent 实发」
 * 判别而非 receipt.status：新题 admission 恒 withheld ⇒ receipt 'withheld'，
 * 若按 status==='pending' 门槛，sourced 草稿的 intent 会挂到下一次 worker
 * 启动 recovery 才发——与供给候选链的即时核验不等价。失败留 durable
 * intent，绝不翻转已提交结果、不重入生成。
 */
export async function drainSubmitVerifyIntents(db: Db, result: SubmitResult): Promise<void> {
  const verifyIntent =
    'verify_enqueued' in result && result.verify_enqueued === true ? result.question_id : null;
  if (verifyIntent == null) return;
  try {
    const dispatch = await dispatchPendingVerifyIntents(db, {
      questionIds: [verifyIntent],
      enqueue: async (verifier, ids, options) => {
        if (verifier !== 'source_verify') {
          throw new Error(`submit_question outbox received unexpected verifier '${verifier}'`);
        }
        const { getStartedBoss } = await import('@/server/boss/client');
        const boss = await getStartedBoss();
        await boss.send('source_verify', { question_ids: ids }, options);
      },
    });
    if (dispatch.failed > 0) {
      console.error(
        '[submit_question] source_verify enqueue failed; durable intent left:',
        verifyIntent,
      );
    }
  } catch (err) {
    console.error('[submit_question] verify dispatch failed (durable intent remains):', err);
  }
}

// ---------- 声明组的一次性原子持久化（save + submit 同事务） ----------

export interface DeclaredGroupPersistParams {
  /** producer 声明文档（局部 id 允许；本函数在 save 指纹前按 namespace 绑定）。 */
  document: QuestionDraftDocumentT;
  /**
   * 绑定命名空间：从既有请求/来源/paid-output 身份确定性派生
   * （如 `yuk1568-candidate:<request_id>`）。同候选重放给同一 namespace。
   */
  idNamespace: string;
  /** 草稿 save 的幂等 request_id（如 `${candidateRequestId}:save`）。 */
  saveRequestId: string;
  /** 提交的幂等 request_id（如 `${candidateRequestId}:submit`）。 */
  submitRequestId: string;
  availability?: 'general_pool' | 'container_only';
  /** 供给链注入（原样透传进 submit；与 producer 可同现，重叠字段 producer 优先）。 */
  sourced?: SubmitDraftInput['sourced'];
  /** 可信新组投影（materializeParts/newGroupId 缺省由本入口按绑定结果填充）。 */
  producer?: TrustedNewGroupProjection;
  ctx: SharedSubmitContext;
}

export type DeclaredGroupPersistResult =
  | { status: 'completed'; save: EditQuestionResult; submit: SubmitResult }
  | { status: 'declaration_failed'; issues: { code: string; detail: string }[] }
  | { status: 'save_failed'; save: EditQuestionResult }
  | { status: 'submit_aborted'; submit: SubmitResult };

interface PersistOk {
  save: EditQuestionResult;
  submit: SubmitResult;
}

/**
 * 声明组 save+submit 的一次性原子链（事务内核形态）。
 * 绑定 → save → submit 全在同一调用方事务内：任何一步需要回滚都会撤销
 * 草稿行/事件/根行/子行/发布 —— 不存在「草稿已落库但组没建成」的半态。
 * 步骤级失败以 SharedSubmitAbort 抛出，由最外 Db 入口转换终态结果。
 */
export async function persistDeclaredQuestionGroupInTx(
  tx: Tx,
  params: DeclaredGroupPersistParams,
): Promise<PersistOk> {
  // 身份绑定只在这里发生一次（调用方不得预先绑定再传入——双重绑定会再铸
  // 一轮 id）。绑定是纯确定性工作，放事务内与 save 指纹同序。
  const bound = bindDeclaredGroupIds(params.document, { namespace: params.idNamespace });
  if (!bound.ok) {
    throw new SharedSubmitAbort('declare', { issues: bound.issues });
  }
  const producer: TrustedNewGroupProjection = {
    materializeParts: 'parent-parts',
    ...params.producer,
    // 根组真实 id 恒取绑定派生值 —— 声明侧不可自授组身份。
    newGroupId: bound.bound.groupId,
  };

  let save: EditQuestionResult;
  try {
    save = await saveDraftEditInTx(tx, {
      input: {
        action: 'save',
        document: bound.bound.document,
        request_id: params.saveRequestId,
      },
      ctx: params.ctx,
    });
  } catch (err) {
    if (err instanceof TxAbort) {
      throw new SharedSubmitAbort('save', { save: err.result });
    }
    throw err;
  }
  if (save.status !== 'saved' && save.status !== 'noop') {
    throw new SharedSubmitAbort('save', { save });
  }
  const draftRef = save.draft_ref;
  if (draftRef == null) {
    throw new SharedSubmitAbort('save', {
      save: {
        status: 'rejected',
        reason: 'draft save returned no draft_ref',
        issues: [{ code: 'missing_draft_ref', detail: 'save receipt carried no draft_ref' }],
        request_id: params.saveRequestId,
      },
    });
  }

  const submit = await submitDraftQuestionInTx(
    tx,
    {
      draft_ref: draftRef,
      request_id: params.submitRequestId,
      // 绑定器已拒绝 doc.base ⇒ 恒为新组首提交：显式钉「尚无已发布
      // revision」，CAS 与首跑/重放路径同一判定。
      expected_revision: null,
      availability: params.availability,
      sourced: params.sourced,
    },
    params.ctx,
    { producer },
  );
  if (submit.status === 'conflict') {
    // conflict 提交须随外层事务回滚（草稿/根/子行/claim 不落半个）。
    throw new SharedSubmitAbort('submit', { submit });
  }
  return { save, submit };
}

/**
 * Db 外层入口：开最外事务，全链成功后 drain verify intent（事务外），并把
 * 步骤级 abort 转成终态结果 —— TxAbort/SharedSubmitAbort 绝不漏到模型面。
 */
export async function persistDeclaredQuestionGroup(
  db: Db,
  params: DeclaredGroupPersistParams,
): Promise<DeclaredGroupPersistResult> {
  let out: PersistOk;
  try {
    out = await db.transaction(async (tx) => persistDeclaredQuestionGroupInTx(tx, params));
  } catch (err) {
    if (err instanceof SharedSubmitAbort) {
      if (err.stage === 'declare') {
        return {
          status: 'declaration_failed',
          issues: err.payload.issues ?? [
            { code: 'invalid_declared_identity', detail: 'declared group identity rejected' },
          ],
        };
      }
      if (err.stage === 'save') {
        return {
          status: 'save_failed',
          save: err.payload.save ?? {
            status: 'rejected',
            reason: 'draft save aborted',
            issues: [{ code: 'save_aborted', detail: err.message }],
            request_id: params.saveRequestId,
          },
        };
      }
      if (err.payload.submit != null) {
        return { status: 'submit_aborted', submit: err.payload.submit };
      }
      throw err;
    }
    if (err instanceof TxAbort) {
      return { status: 'save_failed', save: err.result };
    }
    if (err instanceof TypedGroupProjectionError) {
      // 投影哨兵：整事务已回滚，如实返回提交侧冲突终态（不落半个组）。
      return {
        status: 'submit_aborted',
        submit: {
          status: 'conflict',
          reason: 'invalid_request',
          detail: err.message,
          request_id: params.submitRequestId,
        },
      };
    }
    throw err;
  }
  await drainSubmitVerifyIntents(db, out.submit);
  return { status: 'completed', save: out.save, submit: out.submit };
}
