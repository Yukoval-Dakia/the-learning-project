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
//     （可信投影面 + 父子行物化）在同一个最外事务里完成。业务终态
//     （declaration/save/submit conflict）以结果返回、随事务提交 ——
//     冲突回执与 exact/source KC merge 副作用按旧 submit tx 口径落库；
//     save 中止、投影后的发布冲突及内部错误穿透事务回滚，绝不交半个
//     草稿/根/子行。commit 后才 drain verify intent（drainSubmitVerifyIntents）。
//     `caller` 槽位把调用方的 canonical receipt 写进同一事务 ——
//     claim+domain+receipt 一次 commit，commit 前崩溃无「域已提交而
//     顶层回执缺失」窗口。R1-F1：同 request 已有升级前【原始未绑定文档】
//     的 save 回执时，先原指纹重放恢复（原 submit 语义，无 producer），
//     不误把半成品判成 request_id_reused。
//
//   - claim/receipt/fingerprint 原语（claimSubmitRequestId、
//     writeSubmitReceiptEvent、submitRequestFingerprint）—— candidate/compat
//     提交路径与本内核共用同一 claim 纪律与回执事件形状。
//
// 判定逻辑（准入/判分层比对/契约屏障/presentation/来源归属/近似去重）在
// submit-decision.ts；typed 身份绑定与子行投影在 typed-group.ts。
// ====================================================================

import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  canonicalQuestionContentHash,
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import { encodeDraftRef, parseDraftRef } from '@/core/question-draft-ref';
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
import { getR2 } from '@/kernel/object-storage';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishedContractSeal } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { applyQuestionBlockTransition } from '@/kernel/records/question-block-transitions';
import {
  applyScoringEditPlan,
  draftCanonicalIdentity,
  draftDocumentToContract,
} from '@/kernel/records/question-draft-contract';
import {
  type EditQuestionResult,
  TxAbort,
  findDraftSaveReceipt,
  saveDraftEditInTx,
} from '@/server/questions/edit-question';
import {
  SOURCE_KIND_TO_QUESTION_SOURCE,
  admissionForContentEdit,
  attributableSourceIssue,
  canonicalJson,
  contractBarrierIssues,
  conversionWithheld,
  deriveKind,
  presentationForDraft,
  runAdmissionChecks,
} from '@/server/questions/submit-decision';
import type { SubmitDraftInput, SubmitResult } from '@/server/questions/submit-question';
import {
  type BindIssue,
  type BoundIdMap,
  assertTypedGroupChildrenInsertable,
  bindDeclaredGroupIds,
  typedChildChoicesMd,
} from '@/server/questions/typed-group';
import { type DraftSubmitVector, deduplicateNewDraftInTx } from './draft-submit-dedup';

export const DRAFT_SUBMIT_ACTION = 'experimental:question_draft_submit';

type BlockRow = typeof question_block.$inferSelect;

/** 与 submit-question.ts 既有 SubmitContext 同形（facade 委托不窄化）。 */
export interface SharedSubmitContext {
  beforeWrite?: (tx: Tx) => Promise<void>;
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  sessionId?: string | null;
  taskRunId?: string;
  causedByEventId?: string | null;
  now?: Date;
}

/**
 * 可信新组投影（系统侧组装；绝不暴露给模型输入）。仅新组首次提交生效。
 * 只承载确定性组/part 投影需要的最小可信输入：行内容列、来源归属、
 * provenance/difficulty/claim 全部仍由 `input.sourced` 与文档按原口径
 * 权威供给 —— 本对象不做第二覆盖通道。
 */
export interface TrustedNewGroupProjection {
  /** 根组真实 id（缺省由内核铸 cuid2）。typed 组路径恒为绑定派生值。 */
  newGroupId?: string;
  /** 'parent-parts'：doc.parts>1 时按声明序投影真实 question 子行。 */
  materializeParts?: 'parent-parts';
}

export interface SharedSubmitOptions {
  /** The public draft-submit boundary owns the outside-transaction vector preparation. */
  checkDraftVector?: boolean;
  /** Derived from a validated draft outside the transaction; never a model input. */
  draftVector?: DraftSubmitVector;
  producer?: TrustedNewGroupProjection;
  /**
   * 绑定器产出的 declared→bound 映射（仅给子行投影写 declared_part_id
   * 留痕）。是 namespace+document 的纯函数结果、由 save 侧 receipt 钉住 —
   * 不进 request 指纹。
   */
  declaredIdMap?: BoundIdMap;
}

/** Publishing can reject after row projection; this result must escape the transaction. */
export class SubmitTransactionAbort extends Error {
  constructor(public readonly receipt: Extract<SubmitResult, { status: 'conflict' }>) {
    super(receipt.detail);
    this.name = 'SubmitTransactionAbort';
  }
}

// ---------- 请求指纹 / 回执（与 save 同一幂等纪律） ----------

/**
 * 提交请求指纹：request_id 幂等重放的内容绑定。无 opts.producer 时与
 * main 的 submitDraftQuestion 指纹逐字节一致（同字段集、同缺省形状）；
 * producer 只在确实指定时才加入指纹。sourced 的身份字段进指纹，
 * metadata/supply_trace 等簿记（含 attempt 时间戳）不进 ——
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
        // Identity fields bind the replay; metadata is bookkeeping with timestamps that
        // drift across retries, so it stays out of the fingerprint.
        sourced:
          input.sourced != null
            ? {
                canonical_content_hash: input.sourced.canonical_content_hash,
                created_by: input.sourced.created_by,
                difficulty: input.sourced.difficulty ?? null,
                // source_claim is deterministic (URL + actor), so it participates;
                // metadata and supply_trace still do not.
                source_claim:
                  input.sourced.source_claim != null
                    ? {
                        source_url: input.sourced.source_claim.source_url,
                        actor_ref: input.sourced.source_claim.actor_ref,
                      }
                    : null,
              }
            : null,
        // producer 是可信投影输入（组 id + 是否物化子行）：指定时才进指纹；
        // 缺省路径指纹与旧实现完全一致 —— 升级前已存的 :submit 回执不受影响。
        ...(opts?.producer != null
          ? {
              producer: {
                new_group_id: opts.producer.newGroupId ?? null,
                materialize_parts: opts.producer.materializeParts ?? null,
              },
            }
          : {}),
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

/** Submit receipt event: draft submits target question_block, candidate submits question. */
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
    session_id: ctx.sessionId ?? null,
    task_run_id: ctx.taskRunId ?? null,
    caused_by_event_id: ctx.causedByEventId ?? null,
    actor_kind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
    actor_ref: ctx.actorRef,
    action: DRAFT_SUBMIT_ACTION,
    subject_kind: subject.kind,
    subject_id: subject.id,
    outcome: 'success',
    payload: { request_id: requestId, fingerprint, receipt },
    created_at: now,
    ingest_at: now,
  });
}

// ---------- 提交事务内核 ----------

/**
 * submitDraftQuestion 的完整业务（事务内核形态）。语义与原 Db 入口逐行一致；
 * 扩展面只有 opts.producer（可信新组投影：绑定组 id + 父子行物化）。
 */
export async function submitDraftQuestionInTx(
  tx: Tx,
  input: SubmitDraftInput,
  ctx: SharedSubmitContext,
  opts?: SharedSubmitOptions,
): Promise<SubmitResult> {
  await ctx.beforeWrite?.(tx);
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
  // Shape check: qrev1:<id>:<digest> or a bare revision_id. Malformed values reject;
  // undefined defers to doc.base.revision_id, null expects no published revision.
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
  // request_id idempotency: same content replays the receipt, different content rejects.
  const fingerprint = submitRequestFingerprint(input, opts);
  const now = ctx.now ?? new Date();
  // Serialize same-request_id submissions, then look for a replay inside the lock.
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

  // Default CAS uses the draft's pinned base revision; explicit expected_revision
  // overrides it. Keep null distinct from undefined or the CAS turns off.
  const pinnedBaseRevision =
    doc.base == null || doc.base.revision_id === undefined ? undefined : doc.base.revision_id;
  const effectiveExpectedRevision =
    expectedRevisionId !== undefined ? expectedRevisionId : pinnedBaseRevision;

  const groupId =
    doc.base?.question_id ?? block.imported_question_id ?? opts?.producer?.newGroupId ?? createId();
  let contract = draftDocumentToContract(doc, groupId);
  const editingExisting = doc.base?.question_id != null || block.imported_question_id != null;

  // New questions fail fast on conversion issues; edits wait for the scoring plan,
  // because a verbatim copy of the stored layers may clear them.
  if (!editingExisting && contract.conversion_issues.length > 0) {
    return conversionWithheld(contract, requestId);
  }

  // Group state (CAS + lifecycle snapshot); the publish seam rechecks the token.
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

  // Admission hook: dual-solve/calibration lanes extend this decision.
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

  // question is the working-copy projection; the revision remains scoring truth.
  const identity = draftCanonicalIdentity(doc);
  const canonicalHash = canonicalQuestionContentHash(identity);
  const structuredProjection = draftDocumentToStructuredQuestion(doc);
  const promptMd = identity.promptMd;
  const referenceMd = identity.referenceMd;
  const choicesMd = identity.choicesMd;
  // Row presence drives insert vs update; an empty lifecycle does not mean no row.
  const [existingRow] = await tx
    .select({ id: question.id, source: question.source })
    .from(question)
    .where(eq(question.id, groupId))
    .limit(1);
  const isNew = existingRow == null;
  // System injection is valid only on a new group's first submit; reject misuse
  // instead of silently dropping it.
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
    doc.source != null
      ? (SOURCE_KIND_TO_QUESTION_SOURCE[doc.source.kind] ?? 'quiz_gen')
      : (existingRow?.source ?? 'manual');
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
  // Unresolved conversion means no revision. Withheld results are not receipted:
  // a deterministic request_id would otherwise replay the failure forever.
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
    const dedup = await deduplicateNewDraftInTx(tx, {
      input,
      document: doc,
      groupId,
      blockId: block.id,
      draftVersion: block.version,
      canonicalHash,
      text: { prompt_md: promptMd, reference_md: referenceMd, choices_md: choicesMd },
      taskRunId: ctx.taskRunId,
      now,
      checkDraftVector: opts?.checkDraftVector === true,
      draftVector: opts?.draftVector,
    });
    if ('conflict' in dedup) {
      await writeSubmitReceiptEvent(
        tx,
        { kind: 'question_block', id: block.id },
        requestId,
        fingerprint,
        dedup.conflict,
        ctx,
        now,
      );
      return dedup.conflict;
    }
    const hashForDedup = dedup.canonicalHash;
    await tx.insert(question).values({
      id: groupId,
      kind: deriveKind(doc),
      prompt_md: promptMd,
      reference_md: referenceMd,
      choices_md: choicesMd,
      knowledge_ids: doc.knowledge_ids,
      source: questionSource,
      source_ref: doc.source?.ref ?? null,
      draft_status: 'draft',
      structured: structuredProjection,
      // Sourcing provenance when injected, otherwise submit_question's own system ref.
      created_by:
        input.sourced?.created_by ?? AgentRef.parse({ by: 'ai', task_kind: 'submit_question' }),
      metadata: {
        draft_block_id: block.id,
        submit_source: doc.source ?? null,
        schema_version: 2,
        // System provenance/supply metadata; source_verify depends on it.
        ...(input.sourced?.metadata ?? {}),
        ...dedup.metadata,
      },
      created_at: now,
      updated_at: now,
      canonical_content_hash: hashForDedup,
      ...(input.sourced?.difficulty != null ? { difficulty: input.sourced.difficulty } : {}),
    });
    // typed 组首发：多 part 文档在同事务投影真实子行 —— 契约 part_id 即
    // 子行 question.id（绑定器保证），parent_question_id/part_index 是唯一
    // part-ness/序权威；不逐 child FromRow 重发，发布 seam 一次覆盖全组。
    // YUK-1043 per-site 纪律：内容写点的 INSERT 字面量留在本函数（与
    // publishQuestionGroup 同闭包，writer 审计可见）；锁/查重与 choices
    // 判定等纯逻辑仍在 typed-group。
    if (producer?.materializeParts === 'parent-parts' && doc.parts.length > 1) {
      await assertTypedGroupChildrenInsertable(tx, { groupId, document: doc });
      const declaredPartIds = new Map(
        Object.entries(opts?.declaredIdMap?.part ?? {}).map(
          ([local, boundId]) => [boundId, local] as const,
        ),
      );
      await tx.insert(question).values(
        doc.parts.map((part, index) => {
          // 单 part 文档投影 ⇒ 子行内容列与「该 part 独立成题」的权威配方
          // 同源；options 只在本 part 恰好一个 select 单元时落列。
          const childDoc: QuestionDraftDocumentT = { ...doc, parts: [part] };
          const identity = draftCanonicalIdentity(childDoc);
          const declaredPartId = declaredPartIds.get(part.part_id);
          return withAnswerClass({
            id: part.part_id,
            kind: 'question_part',
            prompt_md: part.prompt_md,
            reference_md: identity.referenceMd,
            choices_md: typedChildChoicesMd(part),
            knowledge_ids: doc.knowledge_ids,
            difficulty: input.sourced?.difficulty ?? 3,
            source: questionSource,
            source_ref: doc.source?.ref ?? null,
            variant_depth: 0,
            parent_question_id: groupId,
            part_index: index,
            draft_status: 'draft',
            figures: [],
            image_refs: [],
            structured: draftDocumentToStructuredQuestion(childDoc),
            metadata: {
              part_of_question_id: groupId,
              part_index: index,
              draft_block_id: block.id,
              // created_by 保持 NULL（ADR-0006 v2）—— provenance 走
              // metadata.produced_by/declared_part_id 留痕。
              ...(declaredPartId != null && declaredPartId !== part.part_id
                ? { declared_part_id: declaredPartId }
                : {}),
              ...(input.sourced?.created_by != null
                ? { produced_by: input.sourced.created_by }
                : {}),
            },
            created_at: now,
            updated_at: now,
            version: 0,
          });
        }),
      );
    }
  } else {
    // Editing a published question: a hash held by another row is a conflict.
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
    // The row projects the currently admitted revision. Unpublishable edits keep the
    // previous content and mark the row draft; only admitted edits update content.
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

  // The single publish seam.
  const publishResult = await publishQuestionGroup(tx, {
    group_id: groupId,
    readAssetBytes: (storageKey) => getR2().get(storageKey),
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
    throw new SubmitTransactionAbort({
      status: 'conflict',
      reason: 'publish_conflict',
      detail: `publish seam conflict (${publishResult.reason})`,
      question_id: groupId,
      current_revision_ref: publishResult.current_revision_id,
      request_id: requestId,
    });
  }
  const revisionId =
    publishResult.status === 'published' || publishResult.status === 'noop'
      ? ((publishResult as { revision_id?: string }).revision_id ??
        (publishResult as { current_revision_id?: string }).current_revision_id)
      : undefined;

  // Draft terminal state + verify outbox for fetched sources.
  await applyQuestionBlockTransition(
    tx,
    {
      kind: 'complete_submit',
      draft: { id: block.id, version: block.version },
      questionId: groupId,
      actor: {
        kind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
        ref: ctx.actorRef,
      },
    },
    now,
  );

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
    // Priority: withheld (gate) > pending (awaiting verify) > admitted.
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

/**
 * 本链可能提交的域终态（replayed / request_id_reused 属于 caller 幂等域，
 * 不经过这里）。`submit_conflict` 是【已提交】终态：草稿保留为可修
 * 'draft'、冲突回执与 duplicate_source/duplicate_exact 的 KC merge/URL
 * claim-release 副作用按旧 submit tx 口径落库 —— 绝不回滚已执行的 merge。
 */
export type DeclaredGroupDomainOutcome =
  | {
      status: 'completed';
      save: EditQuestionResult;
      submit: SubmitResult;
      /** 首发绑定链 = BoundIdMap；R1-F1 恢复链（原 save 半成品按原文档指纹
       * 重放 + 原 submit 语义完成）无新绑定 —— null 如实标记。 */
      id_map: BoundIdMap | null;
    }
  | {
      status: 'submit_conflict';
      save: EditQuestionResult;
      submit: Extract<SubmitResult, { status: 'conflict' }>;
      id_map: BoundIdMap | null;
    }
  | { status: 'save_failed'; save: EditQuestionResult }
  | { status: 'declaration_failed'; issues: BindIssue[] };

export type DeclaredGroupPersistResult =
  | DeclaredGroupDomainOutcome
  | { status: 'submit_rolled_back'; submit: Extract<SubmitResult, { status: 'conflict' }> }
  | { status: 'replayed'; receipt: SubmitResult }
  | { status: 'request_id_reused'; request_id: string; detail: string };

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
  /**
   * 供给链注入（原样透传进 submit）：路由 provenance / flat dedup 指纹 /
   * difficulty / 一页一题 source_claim / verify supply_trace 的权威通道。
   */
  sourced?: SubmitDraftInput['sourced'];
  ctx: SharedSubmitContext;
  /**
   * 调用方 canonical 幂等域（如 candidate request_id）：声明给出后，
   * request_id advisory lock + receipt replay/reuse 检查在本事务内最先
   * 执行；每个【已提交】域终态落库前经 `receipt` 回调写调用方回执 ——
   * domain 工作与调用方回执同一 commit，commit 前崩溃不留「域已提交而
   * 顶层回执缺失」窗口。不提供则跳过调用方幂等面（锁序：caller
   * request_id → saveRequestId → submitRequestId → 域内行锁）。
   */
  caller?: {
    requestId: string;
    fingerprint: string;
    /** 终态 → canonical 回执写参；返回 null = 该终态不写调用方回执。
     *  `ctx` 缺省用 params.ctx；调用方回执归属与域写口 actor 不同的
     *  场景（如 canonical receipt 的 agent 归因 ≠ merge actor）显式给出。 */
    receipt: (outcome: DeclaredGroupDomainOutcome) => {
      subject: { kind: 'question_block' | 'question'; id: string };
      receipt: SubmitResult;
      ctx?: SharedSubmitContext;
    } | null;
  };
}

/**
 * 声明组 save+submit 的一次性原子链（事务内核形态）。
 * caller claim → 绑定 → save → submit → caller receipt 全在同一事务内；
 * 业务终态以结果返回并随事务提交（冲突回执/merge 副作用不丢）；
 * save 中止、投影后的发布冲突、TypedGroupProjectionError / DB 错误必须
 * 穿透最外事务；只在事务回滚后转换可返回的业务结果。
 */
export async function persistDeclaredQuestionGroupInTx(
  tx: Tx,
  params: DeclaredGroupPersistParams,
): Promise<DeclaredGroupPersistResult> {
  await params.ctx.beforeWrite?.(tx);
  const caller = params.caller;
  const now = params.ctx.now ?? new Date();
  const writeCallerReceipt = async (outcome: DeclaredGroupDomainOutcome) => {
    if (caller == null) return;
    const write = caller.receipt(outcome);
    if (write != null) {
      await writeSubmitReceiptEvent(
        tx,
        write.subject,
        caller.requestId,
        caller.fingerprint,
        write.receipt,
        write.ctx ?? params.ctx,
        now,
      );
    }
  };
  // 调用方幂等域先认领：锁内查重放 —— 命中直接回执，指纹不符拒绝。
  if (caller != null) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${caller.requestId}))`);
    const existing = await findSubmitReceipt(tx, caller.requestId);
    if (existing != null) {
      return existing.fingerprint === caller.fingerprint
        ? {
            status: 'replayed',
            receipt: { ...existing.receipt, replayed: true } as SubmitResult,
          }
        : {
            status: 'request_id_reused',
            request_id: caller.requestId,
            detail: `request_id '${caller.requestId}' was used with different content`,
          };
    }
  }

  // YUK-1568 S3 R1-F1 — 升级前半成品恢复：旧版链可能已用同一 :save
  // request_id 对【原始未绑定】文档写过 save 回执（随后 submit/顶层回执
  // 崩溃缺失）。此时若直接对新绑定文档算指纹会得到 request_id_reused 并
  // 把半成品固化 —— 必须先以原文档经同一 saveDraftEditInTx 内核重放
  // （同 request advisory lock、同指纹算法），恢复原 draft 后按原 submit
  // 语义（无 producer ⇒ 旧指纹/平铺投影）完成提交或重放既有 :submit
  // 回执；不重发布、不另付费核验。只对【确无历史 save】的首发才走下方
  // 新绑定链 —— 不误把所有同 request 冲突当 legacy（指纹不符的探测落回
  // 绑定链，由 bound save 产出同一诚实 request_id_reused 终态）。
  // Decide legacy resume versus new binding under the save request's own lock.
  // The caller lock alone does not serialize an older independent save writer.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.saveRequestId}))`);
  const preExistingSave = await findDraftSaveReceipt(tx, params.saveRequestId);
  if (preExistingSave != null) {
    const resumed = await saveDraftEditInTx(tx, {
      input: {
        action: 'save',
        document: params.document,
        request_id: params.saveRequestId,
      },
      ctx: params.ctx,
    });
    if (resumed.status === 'saved' || resumed.status === 'noop') {
      const submit = await submitDraftQuestionInTx(
        tx,
        {
          draft_ref: resumed.draft_ref,
          // 与旧 live caller 同口径：CAS 钉住 save 回执版本。
          expected_draft_version: resumed.draft_version,
          request_id: params.submitRequestId,
          expected_revision: null,
          availability: params.availability,
          sourced: params.sourced,
        },
        params.ctx,
      );
      const resumedOutcome: DeclaredGroupDomainOutcome =
        submit.status === 'conflict'
          ? { status: 'submit_conflict', save: resumed, submit, id_map: null }
          : { status: 'completed', save: resumed, submit, id_map: null };
      await writeCallerReceipt(resumedOutcome);
      return resumedOutcome;
    }
    // request_id_reused / rejected：既有回执指纹不符（非本请求的历史 save），
    // 不绑定恢复 —— 下方新文档 save 会得到同一 request_id_reused 诚实终态。
  }

  // 身份绑定只在这里发生一次（调用方不得预先绑定再传入——双重绑定会再铸
  // 一轮 id）。绑定是纯确定性工作，放事务内与 save 指纹同序。
  const bound = bindDeclaredGroupIds(params.document, { namespace: params.idNamespace });
  if (!bound.ok) {
    const outcome: DeclaredGroupDomainOutcome = {
      status: 'declaration_failed',
      issues: bound.issues,
    };
    await writeCallerReceipt(outcome);
    return outcome;
  }
  const producer: TrustedNewGroupProjection = {
    materializeParts: 'parent-parts',
    // 根组真实 id 恒取绑定派生值 —— 声明侧不可自授组身份。
    newGroupId: bound.bound.groupId,
  };

  const save = await saveDraftEditInTx(tx, {
    input: {
      action: 'save',
      document: bound.bound.document,
      request_id: params.saveRequestId,
    },
    ctx: params.ctx,
  });
  if (save.status !== 'saved' && save.status !== 'noop') {
    const outcome: DeclaredGroupDomainOutcome = { status: 'save_failed', save };
    await writeCallerReceipt(outcome);
    return outcome;
  }

  const submit = await submitDraftQuestionInTx(
    tx,
    {
      draft_ref: save.draft_ref,
      // 与旧 live caller 同口径：CAS 钉住刚写出的草稿版本（save 回执版本）。
      expected_draft_version: save.draft_version,
      request_id: params.submitRequestId,
      // 绑定器已拒绝 doc.base ⇒ 恒为新组首提交：显式钉「尚无已发布
      // revision」，CAS 与首跑/重放路径同一判定。
      expected_revision: null,
      availability: params.availability,
      sourced: params.sourced,
    },
    params.ctx,
    { producer, declaredIdMap: bound.bound.idMap },
  );
  const outcome: DeclaredGroupDomainOutcome =
    submit.status === 'conflict'
      ? { status: 'submit_conflict', save, submit, id_map: bound.bound.idMap }
      : { status: 'completed', save, submit, id_map: bound.bound.idMap };
  await writeCallerReceipt(outcome);
  return outcome;
}

/**
 * Db 外层入口：开最外事务（caller claim/replay/receipt、绑定、save、submit
 * 一次 commit），commit 成功后 drain verify intent；TypedGroupProjectionError
 * 等内部错误向上抛出（整体已回滚，不伪装成业务结果）。
 */
export async function persistDeclaredQuestionGroup(
  db: Db,
  params: DeclaredGroupPersistParams,
): Promise<DeclaredGroupPersistResult> {
  let out: DeclaredGroupPersistResult;
  try {
    out = await db.transaction((tx) => persistDeclaredQuestionGroupInTx(tx, params));
  } catch (error) {
    // Convert only after the complete outer transaction has rolled back.
    if (error instanceof TxAbort) return { status: 'save_failed', save: error.result };
    if (error instanceof SubmitTransactionAbort) {
      return { status: 'submit_rolled_back', submit: error.receipt };
    }
    throw error;
  }
  if (out.status === 'completed') {
    await drainSubmitVerifyIntents(db, out.submit);
  } else if (out.status === 'replayed') {
    await drainSubmitVerifyIntents(db, out.receipt);
  }
  return out;
}
