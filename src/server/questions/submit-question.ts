import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { mergeExactQuestionDuplicateKnowledgeIds } from '@/capabilities/practice/public';
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
import { knowledge, question, question_block, question_group_lifecycle } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { PublishQuestionGroupResult } from '@/kernel/records/assessment-publication';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/server/boss/verify-dispatch-outbox';
import { projectQuestionBlockGuarded } from '@/server/projections/question_block';
import { writeQuestionBlockLifecycleEvent } from '@/server/projections/question_block-lifecycle-event';
import {
  draftCanonicalContentHash,
  draftDocumentToContract,
} from '@/server/questions/draft-contract';
import { encodeDraftRef, parseDraftRef } from '@/server/questions/edit-question';
import { publishQuestionGroup } from '@/server/questions/publisher';

// ====================================================================
// YUK-1468 — submit_question 领域服务（草稿 → 已发布 revision）
// ====================================================================
//
// 唯一提交闸：草稿（v2 文档或 legacy 适配）→ 契约四层 →
// publishQuestionGroup（唯一 revision writer）。CAS 双令牌沿用发布侧约定：
// expected_draft_version（block.version）+ expected_revision（组 current
// revision）。来源指纹：非 fetch 来源用 draftCanonicalContentHash（可复现），
// 绝不伪造 extraction_hash。
//
// 判分准入钩子：runAdmissionChecks —— 今天的实现 = 既有 gate 语义（KC 活体
// + exact-dup claim + 逐 unit 判分可判性；dual independent solve 与 per-unit
// calibration 由另一 lane 挂同一调用点）。返回 withheld 时给出逐 unit 原因，
// 绝不发明准入。

const DRAFT_SUBMIT_ACTION = 'experimental:question_draft_submit';

export type { EditQuestionInputT, EditQuestionResult } from './edit-question';
export {
  EditQuestionInput,
  probeDraftEdit,
  saveDraftEdit,
  validateDraftEdit,
} from './edit-question';
// YUK-1468 — 统一题目写口 facade：capability 侧只经本模块抵达
// submit/edit/publish/draft-insert 服务（capability→questions 边数守恒审计）。
export { publishQuestionGroupFromRow } from './publisher';
export { insertSourcedDraft } from './sourced-draft-insert';

type BlockRow = typeof question_block.$inferSelect;

export interface SubmitDraftInput {
  draft_ref: string;
  /** CAS：缺省 = 以 draft_ref 里的 version 为期望。 */
  expected_draft_version?: number;
  /** CAS：已发布组的当前 revision（qrev1 ref 或裸 id；null = 期望尚无发布）。 */
  expected_revision?: string | null;
  request_id: string;
  /** 覆盖文档 knowledge_ids（缺省 = 文档自带）。 */
  knowledge_ids?: string[];
  /** 覆盖来源声明（缺省 = 文档 source）。 */
  availability?: 'general_pool' | 'container_only';
}

export interface SubmitUnitOutcome {
  unit_id: string;
  status: 'admitted' | 'withheld' | 'pending' | 'skipped';
  reason?: string;
}

export type SubmitResult =
  | {
      status: 'admitted' | 'withheld' | 'pending';
      question_id: string;
      group_id: string;
      revision_id?: string;
      revision_ref?: string;
      revision_ordinal?: number;
      publish_status?: PublishQuestionGroupResult['status'];
      /** per-unit 判分准入结论（ withheld 原因如实给出）。 */
      per_unit: SubmitUnitOutcome[];
      verify_enqueued?: boolean;
      issues?: { code: string; detail: string; part_id?: string; unit_id?: string }[];
      request_id: string;
      replayed?: boolean;
    }
  | {
      status: 'conflict';
      reason:
        | 'draft_version_cas'
        | 'revision_cas'
        | 'request_id_reused'
        | 'not_a_draft'
        | 'invalid_request'
        | 'duplicate_exact'
        | 'publish_conflict';
      detail: string;
      question_id?: string;
      existing_question_id?: string | null;
      current_draft_ref?: string;
      current_draft_version?: number;
      current_revision_ref?: string | null;
      request_id: string;
      replayed?: boolean;
    }
  | {
      status: 'withheld';
      published: false;
      detail: string;
      issues: { code: string; detail: string; part_id?: string; unit_id?: string }[];
      per_unit: SubmitUnitOutcome[];
      request_id: string;
      replayed?: boolean;
    };

interface SubmitContext {
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  sessionId?: string | null;
  taskRunId?: string;
  causedByEventId?: string | null;
  now?: Date;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
      : v,
  );
}

// ---------- admission 钩子 ----------

export interface AdmissionCheckInput {
  doc: QuestionDraftDocumentT;
  unitSummary: { unit_id: string; judgeable_today: boolean; withheld_reason?: string }[];
  knowledgeIds: string[];
  groupId: string;
}

export interface AdmissionCheckResult {
  /** 今天的 gate：不自行 admitted —— dual-solve/calibration lane 挂此调用点。 */
  admission:
    | { state: 'withheld'; reason: 'unverified_rules' }
    | { state: 'admitted'; evidence: null };
  per_unit: SubmitUnitOutcome[];
  /** 组级原因（dead_knowledge_node 等 —— 阻断提交）。 */
  group_blockers: { code: string; detail: string }[];
}

/**
 * 判分准入检查。今天是既有 gate 的首个实现：
 *   - 逐 unit：deterministic + 完整 key/rule/points ⇒ judgeable（verifiable
 *     候选，准入仍等 dual-solve lane）；model_executor 无 admitted slice ⇒
 *     'no_admitted_executor'；其余 ⇒ human_review / missing_*。
 *   - 组级：knowledge_ids 活体（死节点 ⇒ blocker，与 store_sourced_question
 *     同语义）。
 * dual independent solve + per-unit calibration 由另一 lane 在本函数内扩展。
 */
export async function runAdmissionChecks(
  db: Db | Tx,
  input: AdmissionCheckInput,
): Promise<AdmissionCheckResult> {
  const groupBlockers: AdmissionCheckResult['group_blockers'] = [];
  if (input.knowledgeIds.length > 0) {
    const liveRows = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, input.knowledgeIds), isNull(knowledge.archived_at)));
    const live = new Set(liveRows.map((r) => r.id));
    const dead = input.knowledgeIds.filter((id) => !live.has(id));
    if (dead.length > 0) {
      groupBlockers.push({
        code: 'dead_knowledge_node',
        detail: `knowledge ids 不存在或已归档: ${dead.join(', ')}`,
      });
    }
  }
  const perUnit: SubmitUnitOutcome[] = input.unitSummary.map((u) => ({
    unit_id: u.unit_id,
    status: u.judgeable_today ? 'pending' : 'withheld',
    ...(u.judgeable_today
      ? { reason: 'verification_pending' }
      : { reason: u.withheld_reason ?? 'unjudgeable' }),
  }));
  return {
    admission: { state: 'withheld', reason: 'unverified_rules' },
    per_unit: perUnit,
    group_blockers: groupBlockers,
  };
}

// ---------- question 行投影 ----------

const SOURCE_KIND_TO_QUESTION_SOURCE: Record<string, string> = {
  generated: 'quiz_gen',
  adapted: 'adapted',
  owner_material: 'manual',
  photo_ingest: 'photo_ingest',
  jyeoo_fetch: 'web_sourced',
  sourcing_web: 'web_sourced',
  manual: 'manual',
};

function deriveKind(doc: QuestionDraftDocumentT): string {
  const classes = new Set(doc.parts.flatMap((p) => p.units.map((u) => u.response_class)));
  if (doc.parts.length > 1 || classes.size > 1) return 'composite';
  const only = [...classes][0];
  if (only === 'select') return 'choice';
  if (only === 'blank') return 'fill_blank';
  if (only === 'free') return 'short_answer';
  return 'composite';
}

function projectPrompt(doc: QuestionDraftDocumentT): string {
  if (doc.parts.length === 1) return doc.parts[0].prompt_md;
  const stem = doc.parts
    .flatMap((p) => p.material_ids)
    .map((id) => doc.materials.find((m) => m.material_id === id))
    .find((m) => m != null && m.caption === 'stem/shared context');
  if (stem?.content_md != null) return stem.content_md;
  return doc.parts
    .map((p) => p.prompt_md)
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}

function projectReference(doc: QuestionDraftDocumentT): string | null {
  const texts: string[] = [];
  for (const part of doc.parts) {
    for (const unit of part.units) {
      if (unit.key?.kind === 'blank') {
        texts.push(
          unit.key.key.kind === 'text'
            ? unit.key.key.accepted.join(' / ')
            : String(unit.key.key.value),
        );
      } else if (unit.key?.kind === 'select') {
        const byId = new Map(
          unit.response_spec.kind === 'select'
            ? unit.response_spec.items.map((i) => [i.item_id, i] as const)
            : [],
        );
        const labels = unit.key.accepted_item_ids
          .map((id) => byId.get(id))
          .map((item) =>
            item != null && unit.response_spec.kind === 'select'
              ? String.fromCharCode(
                  65 + unit.response_spec.items.findIndex((i) => i.item_id === item.item_id),
                )
              : '',
          )
          .filter((label) => label.length > 0);
        if (labels.length > 0) texts.push(labels.join(''));
      } else if (unit.reference_md != null) {
        texts.push(unit.reference_md);
      }
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : null;
}

function projectChoices(doc: QuestionDraftDocumentT): string[] | null {
  const unit = doc.parts.flatMap((p) => p.units).find((u) => u.response_spec.kind === 'select');
  if (unit == null || unit.response_spec.kind !== 'select') return null;
  return unit.response_spec.items.map((i) => i.label_md ?? i.item_id);
}

// ---------- 主入口 ----------

export async function submitDraftQuestion(
  db: Db,
  input: SubmitDraftInput,
  ctx: SubmitContext,
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
  const fingerprint = `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        draft_ref: input.draft_ref,
        expected_draft_version: input.expected_draft_version,
        expected_revision: expectedRevisionRaw,
        knowledge_ids: input.knowledge_ids,
        availability: input.availability,
      }),
    )
    .digest('hex')}`;
  const now = ctx.now ?? new Date();
  const out = await db.transaction(async (tx): Promise<SubmitResult> => {
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

    const groupId = doc.base?.question_id ?? block.imported_question_id ?? createId();
    const contract = draftDocumentToContract(doc, groupId);

    // 未决转换 ⇒ 不铸 revision（发布侧 validators 会抛）；如实返回 withheld+原因。
    if (contract.conversion_issues.length > 0) {
      const withheld: SubmitResult = {
        status: 'withheld',
        published: false,
        detail: 'draft has unresolved conversion issues',
        issues: contract.conversion_issues.map((i) => ({
          code: i.code,
          detail: i.detail,
          ...(i.part_id != null ? { part_id: i.part_id } : {}),
          ...(i.unit_id != null ? { unit_id: i.unit_id } : {}),
        })),
        per_unit: contract.unit_summary.map((u) => ({
          unit_id: u.unit_id,
          status: 'withheld',
          ...(u.withheld_reason != null ? { reason: u.withheld_reason } : {}),
        })),
        request_id: requestId,
      };
      await writeSubmitReceiptEvent(
        tx,
        { kind: 'question_block', id: block.id },
        requestId,
        fingerprint,
        withheld,
        ctx,
        now,
      );
      return withheld;
    }

    // 组当前状态（CAS + lifecycle 快照；发布 seam 内部复核同一令牌）。
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, groupId))
      .for('update')
      .limit(1);
    const currentRevisionId = lifecycle?.current_revision_id ?? null;
    if (
      effectiveExpectedRevision !== undefined &&
      effectiveExpectedRevision !== currentRevisionId
    ) {
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
      await writeSubmitReceiptEvent(
        tx,
        { kind: 'question_block', id: block.id },
        requestId,
        fingerprint,
        withheld,
        ctx,
        now,
      );
      return withheld;
    }

    // ---- question 工作副本行（投影；revision 才是判分真相） ----
    const canonicalHash = draftCanonicalContentHash(doc);
    const structuredProjection = draftDocumentToStructuredQuestion(doc);
    const questionSource =
      SOURCE_KIND_TO_QUESTION_SOURCE[doc.source?.kind ?? 'generated'] ?? 'quiz_gen';
    const promptMd = projectPrompt(doc);
    const referenceMd = projectReference(doc);
    const choicesMd = projectChoices(doc);
    // 工作副本行存在与否决定 insert vs update（lifecycle 为空 ≠ 行不存在：
    // 从未发布过的 legacy 行没有 lifecycle）。
    const [existingRow] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, groupId))
      .limit(1);
    const isNew = existingRow == null;
    if (isNew) {
      // live 去重 claim：canonical hash 占用者存在 ⇒ cross-KC merge（与供给
      // 链同语义）；否则插入新行。
      const merged = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash: canonicalHash,
        knowledgeIds: doc.knowledge_ids,
        actorRef: 'sourcing',
        taskRunId: ctx.taskRunId,
        now,
      });
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
        created_by: AgentRef.parse({ by: 'ai', task_kind: 'submit_question' }),
        metadata: {
          draft_block_id: block.id,
          submit_source: doc.source ?? null,
          schema_version: 2,
        },
        created_at: now,
        updated_at: now,
        canonical_content_hash: canonicalHash,
      });
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
      // 工作副本行 = 「当前已准入 revision」的投影。admission 未 admitted
      // 时保留既有 admitted 内容不动（legacy 选择器只认 draft_status /
      // suspended / withdrawn —— Codex P1：未验证的新 prompt/answer 不得
      // 抢先被练习池服务）。真正 admitted 时更新内容列。
      if (admission.admission.state === 'admitted') {
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
        integrity_digest: contract.integrity_digest,
      },
      expectedCurrentRevision: currentRevisionId,
      expectedAdmissionGeneration: lifecycle?.scoring_admission_generation ?? null,
      availability:
        input.availability ??
        (questionSource === 'web_sourced' || questionSource === 'quiz_gen'
          ? 'general_pool'
          : 'container_only'),
      admission: admission.admission,
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
      });
      verifyEnqueued = true;
    }

    const receipt: SubmitResult = {
      // 状态判别序：withheld（闸拒） > pending（已提交待验证） > admitted。
      status:
        admission.admission.state === 'withheld'
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
  });

  // verify outbox 派发（事务后；失败留 durable intent，不翻转提交结果）。
  const verifyIntent = out.status === 'pending' && 'question_id' in out ? out.question_id : null;
  if (verifyIntent != null) {
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
  return out;
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

async function findSubmitReceipt(
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

/** request_id 认领（锁内调用方须先取 pg_advisory_xact_lock(hashtext(request_id))）。
 * 导出供 candidate/compat 提交路径复用同一 claim 纪律。 */
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
  ctx: SubmitContext,
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
    payload: { request_id: requestId, fingerprint, receipt },
    created_at: now,
    ingest_at: now,
  });
}
