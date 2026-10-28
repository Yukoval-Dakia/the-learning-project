import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newId } from '@/core/ids';
import { DRAFT_REF_VERSION, encodeDraftRef, parseDraftRef } from '@/core/question-draft-ref';
import {
  DECLARED_BLANK_COMPARE_VERSION,
  EvaluationContractError,
  type PublishedQuestionRevisionT,
  type SlotResponseT,
  type SubmissionRecordT,
  evaluateSubmissionCore,
  validateExecutionPlan,
  validateResponseSet,
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '@/core/schema/assessment';
import {
  QuestionDraftDocument,
  type QuestionDraftDocumentT,
  draftDocumentToStructuredQuestion,
  isDraftDocumentV2,
  isLegacyStructuredQuestion,
  structuredQuestionToDraftDocument,
} from '@/core/schema/question-draft';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import {
  event,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { persistCapturedQuestionBlock } from '@/kernel/records/question-block-creation';
import { OpaqueJsonInput } from '@/kernel/tools/types';
import { projectQuestionBlockGuarded } from '@/server/projections/question_block';
import {
  applyScoringEditPlan,
  draftDocumentToContract,
  revisionToDraftDocument,
} from '@/server/questions/draft-contract';
import {
  type AppliedChange,
  EditOp,
  type EditOpT,
  type InvalidatedScope,
  type OpIssue,
  applyEditOps,
  computeInvalidatedScope,
  relevantChangesForOps,
} from '@/server/questions/draft-ops';

// ====================================================================
// YUK-1468 — edit_question 领域服务（save / validate / probe）
// ====================================================================
//
// 草稿真相：question_block.structured 上的 v2 文档（schema_version=2）。
// 写路径与本仓既有 fold 纪律一致：
//   - 新草稿：INSERT 行 + experimental:question_block_create（origin='import'）
//     同事务；
//   - 编辑：FOR UPDATE 锁行 → experimental:edit_question_block_structured
//     （op='edit_draft'，primary 携带 AFTER 完整文档）→
//     projectQuestionBlockGuarded 写通；
//   - request_id 幂等回执：experimental:question_draft_save 事件 payload
//     （request_id + 请求指纹 + 回执），同 id 同内容返回同回执，同 id 不同
//     内容显式冲突——不覆盖。
//
// CAS：expected_draft_version（block.version）+ expected_revision（已发布组
// current revision，bank ref qrev1:<id>:<digest> 或裸 revision id）。
// 冲突不自动合并：返回当前值与相关字段，调用方重读后重发。
//
// probe：合成 submission 走 evaluateSubmissionCore 同一入口（不造 attempt /
// candidate / settlement）。确定性方法完整执行；模型方法未注入执行器 ⇒
// 未决如实返回（绝不冒充分数）。每次 probe 写一条 run ref 事件。

const DRAFT_SAVE_ACTION = 'experimental:question_draft_save';
const DRAFT_PROBE_ACTION = 'experimental:question_draft_probe';
const DRAFT_EDIT_ACTION = 'experimental:edit_question_block_structured';

/**
 * expected_revision 输入：`qrev1:<id>:<digest12>` bank ref 或裸 revision id。
 * （与 capabilities/practice/server/tools/bank-ref.ts 的 qrev1 线格式一致；
 * 本地解析避免 server → capability 深层 import —— bank-ref.ts 本身是
 * practice 工具面，本侧只解析引用不执行完整 bank-ref 解析。）
 */
/** expected_revision 解析：undefined = 未给（后由 doc.base.revision_id 默认
 * 填充）；null = 期望组尚无已发布 revision；qrev1 或裸 id 形状有效；其余 =
 * malformed（请求形状错误，如实拒绝而非静默放宽 CAS）。 */
function parseExpectedRevisionToken(
  raw: string | null | undefined,
): { value: string | null | undefined } | { invalid: string } {
  if (raw === undefined) return { value: undefined };
  if (raw === null) return { value: null };
  if (raw.startsWith('qrev1:')) {
    const parts = raw.split(':');
    if (parts.length === 3 && parts[1].length > 0) return { value: parts[1] };
    return { invalid: `malformed qrev1 ref '${raw}'` };
  }
  if (raw.includes(':')) return { invalid: `malformed expected_revision '${raw}'` };
  return /^[a-z0-9]{10,}$/.test(raw)
    ? { value: raw }
    : { invalid: `malformed expected_revision '${raw}'` };
}

// ---------- 输入 ----------

export const DraftProbeResponse = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('select'),
    unit_id: z.string().min(1).optional(),
    slot_id: z.string().min(1).optional(),
    picked: z.array(z.string().min(1)).optional(),
    item_ids: z.array(z.string().min(1)).optional(),
    state: z.enum(['answered', 'blank', 'unknown']).optional(),
  }),
  z.object({
    kind: z.literal('blank'),
    unit_id: z.string().min(1).optional(),
    slot_id: z.string().min(1).optional(),
    text: z.string().default(''),
    state: z.enum(['answered', 'blank', 'unknown']).optional(),
  }),
  z.object({
    kind: z.literal('free'),
    unit_id: z.string().min(1).optional(),
    slot_id: z.string().min(1).optional(),
    text_md: z.string().default(''),
  }),
]);
export type DraftProbeResponseT = z.infer<typeof DraftProbeResponse>;

export const DraftProbe = z.object({
  probe_id: z.string().min(1),
  unit_id: z.string().min(1).optional(),
  response: DraftProbeResponse,
  expected_points: z.number().min(0).optional(),
  expected_status: z.enum(['scored', 'pending', 'unjudgeable']).optional(),
  note: z.string().optional(),
});
export type DraftProbeT = z.infer<typeof DraftProbe>;

export const EditQuestionInput = z
  .object({
    action: z.enum(['save', 'validate', 'probe']),
    /** 创建：完整 v2 文档（与 ops/draft_ref/question_id 互斥）。 */
    // Opaque until save/validate parse it through QuestionDraftDocument; z.json
    // keeps the tool input a JSON document (YUK-1553 C1-1 registration contract).
    document: OpaqueJsonInput.optional(),
    /** 编辑：对草稿（draft_ref）或已发布题（question_id）的局部 ops。 */
    ops: z.array(EditOp).optional(),
    draft_ref: z.string().min(1).optional(),
    /** 已发布题编辑入口：无草稿则按当前 revision 播种一个。 */
    question_id: z.string().min(1).optional(),
    expected_revision: z.string().min(1).nullable().optional(),
    expected_draft_version: z.number().int().min(0).optional(),
    /** 幂等键（save 必填；validate/probe 可选但建议携带）。 */
    request_id: z.string().min(1).optional(),
    probes: z.array(DraftProbe).optional(),
  })
  .strict();
export type EditQuestionInputT = z.infer<typeof EditQuestionInput>;

// ---------- 输出 ----------

export interface EditIssue {
  code: string;
  detail: string;
  part_id?: string;
  unit_id?: string;
  target?: unknown;
  locations?: { offset: number }[];
}

export type EditQuestionResult =
  | {
      status: 'saved' | 'noop';
      draft_ref: string;
      draft_version: number;
      question_id?: string;
      current_published_ref?: string | null;
      changes: AppliedChange[];
      publishable: boolean;
      issues: EditIssue[];
      invalidated: InvalidatedScope;
      request_id?: string;
      replayed?: boolean;
    }
  | {
      status: 'conflict';
      reason:
        | 'draft_version_cas'
        | 'revision_cas'
        | 'request_id_reused'
        | 'target_moved'
        | 'not_a_draft';
      detail: string;
      current_draft_ref?: string;
      current_draft_version?: number;
      current_revision_ref?: string | null;
      relevant_changes?: { field: string; current: unknown }[];
      request_id?: string;
    }
  | { status: 'rejected'; reason: string; issues: EditIssue[]; request_id?: string }
  | {
      status: 'validated' | 'invalid';
      draft_ref?: string;
      issues: EditIssue[];
      publishable: boolean;
    }
  | {
      status: 'probed';
      draft_ref?: string;
      cases: {
        probe_id: string;
        unit_id?: string;
        actual: unknown;
        expected: { points?: number; status?: string } | null;
        matches: boolean | null;
        method_fingerprint: string;
        run_refs: string[];
      }[];
      admission_granted: false;
      run_ref?: string;
    }
  | { status: 'proposed'; proposal_id: string; draft_ref?: string; changes: AppliedChange[] };

interface EditContext {
  beforeWrite?: (tx: Tx) => Promise<void>;
  actorRef: string;
  actorKind: 'agent' | 'user' | 'system';
  taskRunId?: string;
  sessionId?: string | null;
  now?: Date;
}

type BlockRow = typeof question_block.$inferSelect;

// ---------- 工具 ----------

function canonicalJson(value: unknown): string {
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

function requestFingerprint(input: {
  action: 'save';
  draft_ref?: string;
  question_id?: string;
  document?: unknown;
  ops?: EditOpT[];
  expected_revision?: string | null;
  expected_draft_version?: number;
}): string {
  const { request_id: _rid, ...rest } = input as Record<string, unknown>;
  return `sha256:${createHash('sha256').update(canonicalJson(rest)).digest('hex')}`;
}

/** block.structured → v2 文档（legacy 树走入口适配；null ⇒ null）。 */
function documentOf(block: BlockRow): QuestionDraftDocumentT | null {
  const structured = block.structured;
  if (structured == null) return null;
  if (isDraftDocumentV2(structured)) return QuestionDraftDocument.parse(structured);
  if (isLegacyStructuredQuestion(structured)) {
    return structuredQuestionToDraftDocument(structured, block.figures ?? []);
  }
  return null;
}

function opIssues(issues: OpIssue[]): EditIssue[] {
  return issues.map((i) => ({
    code: i.code,
    detail: i.detail,
    ...(i.target != null ? { target: i.target } : {}),
    ...(i.locations != null ? { locations: i.locations } : {}),
  }));
}

function publishIssues(
  doc: QuestionDraftDocumentT,
  groupId: string,
  revision?: typeof question_revision.$inferSelect | null,
): EditIssue[] {
  const encoded = draftDocumentToContract(doc, groupId);
  const applied = applyScoringEditPlan(revision ?? null, doc, encoded);
  if (applied.plan.action === 'refuse') {
    return [{ code: applied.plan.code, detail: applied.plan.detail }];
  }
  const contract = applied.contract;
  const issues: EditIssue[] = contract.conversion_issues.map((i) => ({
    code: i.code,
    detail: i.detail,
    ...(i.part_id != null ? { part_id: i.part_id } : {}),
    ...(i.unit_id != null ? { unit_id: i.unit_id } : {}),
  }));
  // 契约级校验（同一 validators；publish 之前先本地过一遍）。
  for (const i of validateStructure(contract.structure)) {
    issues.push({ code: `structure_${i.code}`, detail: i.detail });
  }
  for (const i of validateResponseSpec(contract.response_spec, contract.structure)) {
    issues.push({ code: `response_spec_${i.code}`, detail: i.detail });
  }
  for (const i of validateScoringBasis(
    contract.scoring_basis,
    contract.response_spec,
    contract.structure,
  )) {
    issues.push({ code: `scoring_basis_${i.code}`, detail: i.detail });
  }
  for (const i of validateExecutionPlan(contract.execution_plan, contract.scoring_basis)) {
    issues.push({ code: `execution_plan_${i.code}`, detail: i.detail });
  }
  return issues;
}

/** Save receipt lookup shared by save and the locked legacy-resume branch. */
export async function findDraftSaveReceipt(
  db: Db | Tx,
  requestId: string,
): Promise<{ fingerprint: string; receipt: unknown } | null> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, DRAFT_SAVE_ACTION),
        sql`${event.payload} ->> 'request_id' = ${requestId}`,
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  const payload = rows[0]?.payload as { fingerprint?: string; receipt?: unknown } | undefined;
  if (payload?.fingerprint == null) return null;
  return { fingerprint: payload.fingerprint, receipt: payload.receipt };
}

// ---------- save ----------

/**
 * 事务内返回 conflict/rejected 须回滚（防孤儿草稿行）时抛出的哨兵。
 * YUK-1568：导出供共享 save/submit 事务（shared-submit 组合入口）把同一
 * save 失败语义折叠进外层原子回滚——捕获方必须在外层事务外转换 result。
 */
export class TxAbort extends Error {
  constructor(public readonly result: EditQuestionResult) {
    super('tx-abort');
    this.name = 'TxAbort';
  }
}

export interface SaveDraftParams {
  input: EditQuestionInputT;
  ctx: EditContext;
}

async function loadDraftBlock(tx: Tx, blockId: string): Promise<BlockRow | undefined> {
  const rows = await tx
    .select()
    .from(question_block)
    .where(eq(question_block.id, blockId))
    .for('update')
    .limit(1);
  return rows[0];
}

/** validate 不持锁。有当前 revision 时，发布结论与 submit 用同一份判分计划。 */
async function currentRevisionForValidate(
  db: Db,
  groupId: string | null,
): Promise<typeof question_revision.$inferSelect | null> {
  if (groupId == null) return null;
  const [lifecycle] = await db
    .select({ revisionId: question_group_lifecycle.current_revision_id })
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .limit(1);
  if (lifecycle?.revisionId == null) return null;
  const [revisionRow] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, lifecycle.revisionId))
    .limit(1);
  return revisionRow ?? null;
}

/** 已发布题的当前组 revision（CAS 对照 + 种子来源）。 */
async function currentGroupRevision(
  tx: Tx,
  groupId: string,
): Promise<{
  revisionId: string | null;
  lifecycle: typeof question_group_lifecycle.$inferSelect | null;
  revisionRow?: typeof question_revision.$inferSelect;
}> {
  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId))
    .for('update')
    .limit(1);
  const revisionId = lifecycle?.current_revision_id ?? null;
  if (revisionId == null) return { revisionId: null, lifecycle: lifecycle ?? null };
  const [revisionRow] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId))
    .limit(1);
  return { revisionId, lifecycle: lifecycle ?? null, revisionRow };
}

/**
 * 为已发布题找草稿：优先复用 status='draft' 且 imported_question_id=qid
 * 的现有块；否则按当前 revision 准备种子（无 revision 时按 question 行
 * 投影）。种子先不落行，调用方算出终态后再铸一条 create 快照。
 */
async function ensureDraftForQuestion(
  tx: Tx,
  questionId: string,
): Promise<
  | { block: BlockRow }
  | { seed: QuestionDraftDocumentT; importedQuestionId: string }
  | { error: string }
> {
  const [existing] = await tx
    .select()
    .from(question_block)
    .where(
      and(eq(question_block.imported_question_id, questionId), eq(question_block.status, 'draft')),
    )
    .orderBy(desc(question_block.updated_at))
    .limit(1)
    .for('update');
  if (existing) return { block: existing };

  const [row] = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
  if (row == null) return { error: `question '${questionId}' not found` };
  const { revisionRow } = await currentGroupRevision(tx, questionId);
  let doc: QuestionDraftDocumentT;
  if (revisionRow != null) {
    doc = revisionToDraftDocument(revisionRow, { knowledge_ids: row.knowledge_ids ?? [] });
  } else if (row.structured != null) {
    doc = structuredQuestionToDraftDocument(row.structured, row.figures ?? []);
    doc.base = { question_id: questionId, revision_id: null };
    doc.knowledge_ids = row.knowledge_ids ?? [];
  } else {
    // 平面行 → 最小草稿（free unit + reference 兜底；不完整但可编辑）。
    doc = QuestionDraftDocument.parse({
      schema_version: 2,
      parts: [
        {
          part_id: 'p1',
          prompt_md: row.prompt_md,
          material_ids: [],
          units:
            row.reference_md != null
              ? [
                  {
                    unit_id: 'p1::u',
                    slot_id: 'p1::r',
                    response_class: 'free',
                    response_spec: { kind: 'free' },
                    reference_md: row.reference_md,
                    method: { kind: 'human_review' },
                    material_refs: [],
                    metadata: {},
                  },
                ]
              : [],
          metadata: {},
        },
      ],
      materials: [],
      knowledge_ids: row.knowledge_ids ?? [],
      metadata: {},
      base: { question_id: questionId, revision_id: null },
    });
  }
  // 先不落行。同事务里再写一条编辑事件会和 create 抢同一时间戳，fold 把
  // create 当整行覆盖，编辑（或版本）会丢。调用方算完终态后再铸一条快照。
  return { seed: doc, importedQuestionId: questionId };
}

/**
 * YUK-1568 — save 的完整事务内核（可信 InTx 入口）。承载原 saveDraftEdit
 * 的全部业务：请求形状校验、advisory request 锁、回执重放/复用冲突、
 * 草稿解析、CAS、ops 应用、create/edit 事件与块投影、回执写入。
 * `Tx` 显式声明提交层级——绝不靠 `Db | Tx` 猜测；外事务回滚时本函数的全部
 * 写入随之原子回滚（含 TxAbort 分支：哨兵向上传播，由最外 Db wrapper
 * 在事务外转 result）。
 */
export async function saveDraftEditInTx(
  tx: Tx,
  params: SaveDraftParams,
): Promise<EditQuestionResult> {
  const { input, ctx } = params;
  await ctx.beforeWrite?.(tx);
  const requestId = input.request_id;
  if (requestId == null || requestId.length === 0) {
    return {
      status: 'rejected',
      reason: 'request_id is required for save',
      issues: [{ code: 'missing_request_id', detail: 'save requires request_id for idempotency' }],
    };
  }
  const hasDocument = input.document !== undefined;
  const hasOps = input.ops != null && input.ops.length > 0;
  const hasDraftRef = input.draft_ref != null;
  const hasQuestion = input.question_id != null;
  if (hasDocument === hasOps || (hasDocument && (hasDraftRef || hasQuestion))) {
    return {
      status: 'rejected',
      reason: 'exactly one of document (create) or ops (edit) is required',
      issues: [{ code: 'invalid_request', detail: 'document XOR ops required' }],
      request_id: requestId,
    };
  }
  if (hasOps && !hasDraftRef && !hasQuestion) {
    return {
      status: 'rejected',
      reason: 'ops require draft_ref or question_id',
      issues: [{ code: 'invalid_request', detail: 'ops require draft_ref or question_id' }],
      request_id: requestId,
    };
  }

  const fingerprint = requestFingerprint({ ...input, action: 'save' });

  {
    const now = ctx.now ?? new Date();
    // 建草稿的 create 事件必须用这同一个时间。fold 按 created_at 再按 id
    // 排序，create 是整行 last-write-wins；另取 new Date() 会晚于编辑事件，
    // 把已应用的 ops 盖回 v0。
    const txCtx: EditContext = { ...ctx, now };
    // request_id 认领原子化：advisory xact lock 串行化同 request_id 并发，
    // 锁内查重放（原 check-then-act 竞态在锁外）。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
    const existing = await findDraftSaveReceipt(tx, requestId);
    if (existing != null) {
      if (existing.fingerprint === fingerprint) {
        return {
          ...(existing.receipt as EditQuestionResult),
          replayed: true,
        } as EditQuestionResult;
      }
      return {
        status: 'conflict',
        reason: 'request_id_reused',
        detail: `request_id '${requestId}' was used with different content`,
        request_id: requestId,
      };
    }
    // ---- 解析目标草稿 ----
    // 新建草稿先只准备文档。终态算完后只写一条 create 快照（版本即这次保存）。
    // 同事务再追加编辑事件时，两条事件时间相同；fold 的 create 是整行覆盖，
    // 编辑若按 id 排在前面会被跳过，行版本停在 0，回执却写 1。
    let block: BlockRow | undefined;
    let pending: { doc: QuestionDraftDocumentT; importedQuestionId: string | null } | undefined;
    let draftRefVersion: number | undefined;
    if (hasDocument) {
      const parsedDoc = QuestionDraftDocument.safeParse(input.document);
      if (!parsedDoc.success) {
        return {
          status: 'rejected',
          reason: 'document failed schema validation',
          issues: [{ code: 'invalid_document', detail: parsedDoc.error.message }],
          request_id: requestId,
        };
      }
      pending = {
        doc: parsedDoc.data,
        importedQuestionId: parsedDoc.data.base?.question_id ?? null,
      };
    } else if (hasDraftRef) {
      const draftRef = input.draft_ref;
      if (draftRef == null) {
        return {
          status: 'rejected',
          reason: 'ops require draft_ref or question_id',
          issues: [{ code: 'invalid_request', detail: 'ops require draft_ref or question_id' }],
          request_id: requestId,
        };
      }
      const parsed = parseDraftRef(draftRef);
      if (parsed == null) {
        return {
          status: 'rejected',
          reason: `invalid draft_ref '${input.draft_ref}'`,
          issues: [
            {
              code: 'invalid_draft_ref',
              detail: `expected ${DRAFT_REF_VERSION}:<block>:<version>`,
            },
          ],
          request_id: requestId,
        };
      }
      draftRefVersion = parsed.version;
      const loaded = await loadDraftBlock(tx, parsed.blockId);
      if (loaded == null) {
        return {
          status: 'conflict',
          reason: 'not_a_draft',
          detail: `draft '${parsed.blockId}' not found`,
          request_id: requestId,
        };
      }
      block = loaded;
    } else {
      const questionId = input.question_id;
      if (questionId == null) {
        return {
          status: 'rejected',
          reason: 'ops require draft_ref or question_id',
          issues: [{ code: 'invalid_request', detail: 'ops require draft_ref or question_id' }],
          request_id: requestId,
        };
      }
      const ensured = await ensureDraftForQuestion(tx, questionId);
      if ('error' in ensured) {
        return {
          status: 'rejected',
          reason: ensured.error,
          issues: [{ code: 'target_not_found', detail: ensured.error }],
          request_id: requestId,
        };
      }
      if ('block' in ensured) {
        block = ensured.block;
      } else {
        pending = { doc: ensured.seed, importedQuestionId: ensured.importedQuestionId };
      }
    }

    // ---- CAS（只对已经存在的草稿行） ----
    if (block != null && block.status !== 'draft') {
      return {
        status: 'conflict',
        reason: 'not_a_draft',
        detail: `draft '${block.id}' has status '${block.status}' (already submitted/retired)`,
        request_id: requestId,
      };
    }
    const expectedDraftVersion = input.expected_draft_version ?? draftRefVersion;
    if (block != null && expectedDraftVersion != null && block.version !== expectedDraftVersion) {
      const currentDoc = documentOf(block);
      return {
        status: 'conflict',
        reason: 'draft_version_cas',
        detail: `draft '${block.id}' version is ${block.version}, expected ${expectedDraftVersion}`,
        current_draft_ref: encodeDraftRef(block.id, block.version),
        current_draft_version: block.version,
        ...(currentDoc != null
          ? { relevant_changes: relevantChangesForOps(currentDoc, input.ops) }
          : {}),
        request_id: requestId,
      };
    }

    const docBefore = block != null ? documentOf(block) : (pending?.doc ?? null);
    if (docBefore == null) {
      return {
        status: 'rejected',
        reason: 'draft has no editable structured content',
        issues: [{ code: 'not_a_draft', detail: 'block.structured is null or unrecognized' }],
        request_id: requestId,
      };
    }

    // expected_revision：编辑已发布题时钉住基底 revision。
    const expectedParsed = parseExpectedRevisionToken(input.expected_revision);
    if ('invalid' in expectedParsed) {
      throw new TxAbort({
        status: 'rejected',
        reason: expectedParsed.invalid,
        issues: [{ code: 'invalid_request', detail: expectedParsed.invalid }],
        request_id: requestId,
      });
    }
    // 默认 CAS：draft 钉住的基底 revision 即期望值（防静默 rebase 到未读版本）。
    // base.revision_id 为 null = 建草稿时组尚无已发布版本，保持 null 参与比较；
    // 字段缺省才是「未钉住」。`?? undefined` 会把 null 当成未钉住而关掉 CAS。
    const pinnedBaseRevision =
      docBefore.base == null || docBefore.base.revision_id === undefined
        ? undefined
        : docBefore.base.revision_id;
    const expectedRevisionId =
      expectedParsed.value !== undefined ? expectedParsed.value : pinnedBaseRevision;
    const importedQuestionId = block?.imported_question_id ?? pending?.importedQuestionId ?? null;
    const groupId = docBefore.base?.question_id ?? importedQuestionId;
    let currentRevisionId: string | null = null;
    let currentRevisionRow: typeof question_revision.$inferSelect | null = null;
    if (groupId != null || expectedRevisionId !== undefined) {
      const group = groupId != null ? await currentGroupRevision(tx, groupId) : null;
      currentRevisionId = group?.revisionId ?? null;
      currentRevisionRow = group?.revisionRow ?? null;
      if (expectedRevisionId !== undefined && expectedRevisionId !== currentRevisionId) {
        throw new TxAbort({
          status: 'conflict',
          reason: 'revision_cas',
          detail: `group '${groupId ?? '?'}' current revision is ${currentRevisionId ?? 'none'}, expected ${expectedRevisionId ?? 'none'}`,
          ...(block != null
            ? {
                current_draft_ref: encodeDraftRef(block.id, block.version),
                current_draft_version: block.version,
              }
            : {}),
          current_revision_ref: currentRevisionId,
          relevant_changes: relevantChangesForOps(docBefore, input.ops),
          request_id: requestId,
        });
      }
    }

    // ---- 应用 ops ----
    const applied = hasOps ? applyEditOps(docBefore, input.ops ?? []) : null;
    if (applied != null && !applied.ok) {
      throw new TxAbort({
        status: 'rejected',
        reason: 'ops failed',
        issues: opIssues(applied.issues),
        request_id: requestId,
      });
    }
    const docAfter = applied?.ok === true ? applied.document : docBefore;
    const changes = applied?.ok === true ? applied.changes : [];
    const noop = applied?.ok === true ? applied.noop : false;

    // 草稿的 doc.base 回填（首次针对已发布题的草稿）。
    if (docAfter.base == null && importedQuestionId != null) {
      docAfter.base = { question_id: importedQuestionId, revision_id: currentRevisionId };
    }

    // 还没有行：终态直接铸成 create 快照。不再同事务写编辑事件。
    let fresh = false;
    if (block == null) {
      const draftNow = txCtx.now ?? new Date();
      const blockId = createId();
      block = await persistCapturedQuestionBlock(
        tx,
        {
          origin: 'edit_draft',
          blockId,
          doc: docAfter,
          importedQuestionId,
          actorKind: txCtx.actorKind,
          actorRef: txCtx.actorRef,
          version: 1,
        },
        draftNow,
      );
      fresh = true;
    }

    const issues = publishIssues(docAfter, groupId ?? `draft-${block.id}`, currentRevisionRow);
    const publishable = issues.length === 0;
    const invalidated = computeInvalidatedScope(changes);

    if (noop && hasOps) {
      const foldedNoop = fresh ? await loadDraftBlock(tx, block.id) : block;
      const noopVersion = foldedNoop?.version ?? block.version;
      const receipt: EditQuestionResult = {
        status: 'noop',
        draft_ref: encodeDraftRef(block.id, noopVersion),
        draft_version: noopVersion,
        ...(groupId != null ? { question_id: groupId } : {}),
        changes: [],
        publishable,
        issues,
        invalidated,
        request_id: requestId,
      };
      await writeReceiptEvent(tx, block.id, requestId, fingerprint, receipt, ctx, now);
      return receipt;
    }

    if (!fresh) {
      const nextVersion = block.version + 1;
      await writeEvent(tx, {
        id: newId(),
        // canonical 事件 schema actor_kind 只有 agent|user —— system 调用按 agent 承载。
        actor_kind: ctx.actorKind === 'user' ? 'user' : 'agent',
        actor_ref: ctx.actorRef,
        action: DRAFT_EDIT_ACTION,
        subject_kind: 'question_block',
        subject_id: block.id,
        outcome: 'success',
        payload: {
          op: 'edit_draft',
          affected_blocks: [
            {
              block_id: block.id,
              role: 'primary',
              structured: docAfter,
              version: nextVersion,
              status: block.status,
            },
          ],
        },
        created_at: now,
        ingest_at: now,
      });
      await projectQuestionBlockGuarded(tx, block.id);
    }

    // 回执版本取 fold 之后的行，避免回执写 1、行仍是 0。
    const folded = await loadDraftBlock(tx, block.id);
    const persistedVersion = folded?.version ?? block.version;
    const receipt: EditQuestionResult = {
      status: 'saved',
      draft_ref: encodeDraftRef(block.id, persistedVersion),
      draft_version: persistedVersion,
      ...(groupId != null ? { question_id: groupId } : {}),
      current_published_ref: currentRevisionId,
      changes,
      publishable,
      issues,
      invalidated,
      request_id: requestId,
    };
    await writeReceiptEvent(tx, block.id, requestId, fingerprint, receipt, ctx, now);
    return receipt;
  }
}

/**
 * 现有 Db API 面：签名不变。开外层事务并把所有业务交给 {@link saveDraftEditInTx}；
 * TxAbort 哨兵只在事务完全回滚之后、最外层这里转回 result —— 绝不在事务中
 * 吞失败提交半个 root。
 */
export async function saveDraftEdit(db: Db, params: SaveDraftParams): Promise<EditQuestionResult> {
  try {
    return await db.transaction(async (tx) => saveDraftEditInTx(tx, params));
  } catch (err) {
    if (err instanceof TxAbort) return err.result;
    throw err;
  }
}

async function writeReceiptEvent(
  tx: Tx,
  blockId: string,
  requestId: string,
  fingerprint: string,
  receipt: EditQuestionResult,
  ctx: EditContext,
  now: Date,
): Promise<void> {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
    actor_ref: ctx.actorRef,
    action: DRAFT_SAVE_ACTION,
    subject_kind: 'question_block',
    subject_id: blockId,
    outcome: 'success',
    payload: { request_id: requestId, fingerprint, receipt },
    created_at: now,
    ingest_at: now,
  });
}

// ---------- validate（纯本地检查，不写） ----------

export async function validateDraftEdit(
  db: Db,
  params: SaveDraftParams,
): Promise<EditQuestionResult> {
  const { input } = params;
  let doc: QuestionDraftDocumentT | null = null;
  let draftRef: string | undefined;
  let groupId: string | null = null;
  if (input.document !== undefined) {
    const parsed = QuestionDraftDocument.safeParse(input.document);
    if (!parsed.success) {
      return {
        status: 'invalid',
        issues: [{ code: 'invalid_document', detail: parsed.error.message }],
        publishable: false,
      };
    }
    doc = parsed.data;
    groupId = doc.base?.question_id ?? null;
  } else if (input.draft_ref != null) {
    const parsed = parseDraftRef(input.draft_ref);
    if (parsed == null) {
      return {
        status: 'invalid',
        issues: [
          { code: 'invalid_draft_ref', detail: `expected ${DRAFT_REF_VERSION}:<block>:<version>` },
        ],
        publishable: false,
      };
    }
    const [block] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, parsed.blockId))
      .limit(1);
    if (block == null) {
      return {
        status: 'invalid',
        issues: [{ code: 'target_not_found', detail: `draft '${parsed.blockId}' not found` }],
        publishable: false,
      };
    }
    doc = documentOf(block);
    draftRef = encodeDraftRef(block.id, block.version);
    groupId = doc?.base?.question_id ?? block.imported_question_id;
  } else {
    return {
      status: 'invalid',
      issues: [{ code: 'invalid_request', detail: 'validate requires document or draft_ref' }],
      publishable: false,
    };
  }
  if (doc == null) {
    return {
      status: 'invalid',
      issues: [{ code: 'not_a_draft', detail: 'no v2 draft document' }],
      publishable: false,
      draft_ref: draftRef,
    };
  }
  const revision = await currentRevisionForValidate(db, groupId);
  const issues = publishIssues(doc, groupId ?? 'draft', revision);
  return {
    status: issues.length === 0 ? 'validated' : 'invalid',
    ...(draftRef != null ? { draft_ref: draftRef } : {}),
    issues,
    publishable: issues.length === 0,
  };
}

// ---------- probe（合成 submission 走同一评估入口） ----------

export async function probeDraftEdit(
  db: Db,
  params: SaveDraftParams & { probes: DraftProbeT[] },
): Promise<EditQuestionResult> {
  const { input, ctx, probes } = params;
  let doc: QuestionDraftDocumentT | null = null;
  let draftRef: string | undefined;
  let groupId = 'probe-draft';
  if (input.document !== undefined) {
    const parsed = QuestionDraftDocument.safeParse(input.document);
    if (!parsed.success) {
      return {
        status: 'rejected',
        reason: 'invalid document',
        issues: [{ code: 'invalid_document', detail: parsed.error.message }],
      };
    }
    doc = parsed.data;
    groupId = doc.base?.question_id ?? groupId;
  } else if (input.draft_ref != null) {
    const parsed = parseDraftRef(input.draft_ref);
    if (parsed == null) {
      return {
        status: 'rejected',
        reason: 'invalid draft_ref',
        issues: [{ code: 'invalid_draft_ref', detail: 'bad ref' }],
      };
    }
    const [block] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, parsed.blockId))
      .limit(1);
    if (block == null) {
      return {
        status: 'rejected',
        reason: 'draft not found',
        issues: [{ code: 'target_not_found', detail: `draft '${parsed.blockId}' not found` }],
      };
    }
    if (block.version !== parsed.version) {
      // 钉住的版本已漂移：probe 不得对未读版本放行。
      return {
        status: 'conflict',
        reason: 'draft_version_cas',
        detail: `draft '${block.id}' version is ${block.version}, expected ${parsed.version}`,
        current_draft_ref: encodeDraftRef(block.id, block.version),
        current_draft_version: block.version,
      };
    }
    doc = documentOf(block);
    draftRef = encodeDraftRef(block.id, block.version);
    groupId = doc?.base?.question_id ?? block.imported_question_id ?? groupId;
  }
  if (doc == null) {
    return {
      status: 'rejected',
      reason: 'no draft document',
      issues: [{ code: 'not_a_draft', detail: 'no draft document to probe' }],
    };
  }
  const contract = draftDocumentToContract(doc, groupId);
  const syntheticRevision: PublishedQuestionRevisionT = {
    revision_id: `probe-${createId()}`,
    group_id: groupId,
    revision_ordinal: 1,
    integrity_digest: contract.integrity_digest,
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
    published_at: new Date().toISOString(),
    supersedes_revision_id: null,
  };
  const unitById = new Map(
    doc.parts.flatMap((p) =>
      p.units.map((u) => [u.unit_id, { unit: u, partId: p.part_id }] as const),
    ),
  );
  const slotByUnit = new Map(
    contract.scoring_basis.units.map((u) => [u.scoring_unit_id, u.slot_refs[0]] as const),
  );

  const cases: {
    probe_id: string;
    unit_id?: string;
    actual: unknown;
    expected: { points?: number; status?: string } | null;
    matches: boolean | null;
    method_fingerprint: string;
    run_refs: string[];
  }[] = [];
  const now = ctx.now ?? new Date();
  for (const probe of probes) {
    const unitId = probe.unit_id ?? probe.response.unit_id ?? unitIdFromResponse(probe.response);
    const unitInfo = unitId != null ? unitById.get(unitId) : undefined;
    const slotId = probe.response.slot_id ?? (unitId != null ? slotByUnit.get(unitId) : undefined);
    if (slotId == null) {
      cases.push({
        probe_id: probe.probe_id,
        unit_id: unitId,
        actual: { status: 'failed', detail: 'cannot resolve slot for probe response' },
        expected: null,
        matches: null,
        method_fingerprint: '',
        run_refs: [],
      });
      continue;
    }
    const entry = slotResponseFor(probe.response, slotId);
    const submission: SubmissionRecordT = {
      submission_id: `probe-${createId()}`,
      issuance_id: `probe-iss-${createId()}`,
      revision_id: syntheticRevision.revision_id,
      evaluation_group_id: `probe-eval-${createId()}`,
      response_set: { entries: [entry] },
      group_evidence: [],
      idempotency_key: `probe-${probe.probe_id}-${createId()}`,
      submitted_at: now.toISOString(),
    };
    // 合成 submission 的 response 合法性先过结构校验（与真实入口同纪律）。
    const specIssues = validateResponseSet(contract.response_spec, submission.response_set);
    if (specIssues.length > 0) {
      cases.push({
        probe_id: probe.probe_id,
        unit_id: unitId,
        actual: { status: 'failed', issues: specIssues.map((i) => i.detail) },
        expected: expectedOf(probe),
        matches: null,
        method_fingerprint: '',
        run_refs: [],
      });
      continue;
    }
    let out: Awaited<ReturnType<typeof evaluateSubmissionCore>>;
    try {
      out = await evaluateSubmissionCore({
        evaluation_id: `probe-eval-${createId()}`,
        submission,
        revision: syntheticRevision,
        issued_part_ids: contract.structure.parts.map((p) => p.part_id),
        attempt: 1,
        // probe 不注入 model_executor —— 模型方法如实未决（绝不冒充判分）。
      });
    } catch (err) {
      // 契约错误（EvaluationContractError 等）⇒ 该 case 失败如实上报，不抛穿 probe。
      if (err instanceof EvaluationContractError) {
        cases.push({
          probe_id: probe.probe_id,
          unit_id: unitId,
          actual: { status: 'failed', detail: err.message, error_code: err.code },
          expected: expectedOf(probe),
          matches: false,
          method_fingerprint: '',
          run_refs: [`probe-run:${submission.submission_id}`],
        });
        continue;
      }
      throw err;
    }
    const probeSlot = contract.response_spec.slots.find(
      (candidate) => candidate.slot_id === slotId,
    );
    const fingerprint = methodFingerprint(
      unitInfo?.unit,
      unitId != null
        ? contract.scoring_basis.units.find((u) => u.scoring_unit_id === unitId)
        : undefined,
      probeSlot != null && probeSlot.kind === 'blank' && probeSlot.answer_shape != null
        ? probeSlot.answer_shape
        : null,
    );
    const targetResult =
      unitId != null
        ? out.record.unit_results.find((r) => r.scoring_unit_id === unitId)
        : out.record.unit_results.length === 1
          ? out.record.unit_results[0]
          : undefined;
    const actual =
      targetResult != null
        ? targetResult
        : { status: 'pending', detail: 'unit not in issued scope or not evaluated' };
    const expected = expectedOf(probe);
    const matches = matchesExpected(actual, expected);
    cases.push({
      probe_id: probe.probe_id,
      unit_id: unitId ?? undefined,
      actual,
      expected,
      matches,
      method_fingerprint: fingerprint,
      run_refs: [`probe-run:${submission.submission_id}`],
    });
  }

  // run ref：auditable 留痕（probe 不落 attempt/candidate/settlement）。
  const runRefEvent = `probe-run-${createId()}`;
  try {
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: newId(),
        actor_kind: ctx.actorKind === 'system' ? 'system' : ctx.actorKind,
        actor_ref: ctx.actorRef,
        action: DRAFT_PROBE_ACTION,
        subject_kind: 'question_block',
        subject_id:
          input.draft_ref != null ? (parseDraftRef(input.draft_ref)?.blockId ?? 'draft') : 'draft',
        outcome: 'success',
        payload: {
          probe_count: cases.length,
          run_ref: runRefEvent,
          results: cases.map((c) => ({
            probe_id: c.probe_id,
            unit_id: c.unit_id,
            status: (c.actual as { status?: string })?.status ?? 'unknown',
            method_fingerprint: c.method_fingerprint,
          })),
        },
        created_at: now,
        ingest_at: now,
      });
    });
  } catch {
    // 事件留痕失败不阻塞 probe 结果返回（结果本身不是学习事实）。
  }
  return {
    status: 'probed',
    ...(draftRef != null ? { draft_ref: draftRef } : {}),
    cases,
    admission_granted: false,
    run_ref: runRefEvent,
  };
}

function unitIdFromResponse(response: DraftProbeResponseT): string | undefined {
  return response.unit_id;
}

function expectedOf(probe: DraftProbeT): { points?: number; status?: string } | null {
  if (probe.expected_points == null && probe.expected_status == null) return null;
  return {
    ...(probe.expected_points != null ? { points: probe.expected_points } : {}),
    ...(probe.expected_status != null ? { status: probe.expected_status } : {}),
  };
}

function matchesExpected(
  actual: unknown,
  expected: { points?: number; status?: string } | null,
): boolean | null {
  if (expected == null) return null;
  const result = actual as {
    status?: string;
    points_awarded?: number | null;
    pending?: { reason?: string };
  };
  if (expected.status != null) {
    const status =
      result.status === 'scored'
        ? 'scored'
        : result.status === 'pending'
          ? 'pending'
          : result.status;
    if (expected.status === 'unjudgeable') {
      return result.status === 'pending' && result.pending?.reason === 'unjudgeable';
    }
    if (status !== expected.status) return false;
  }
  if (expected.points != null) {
    return result.status === 'scored' && result.points_awarded === expected.points;
  }
  return true;
}

function slotResponseFor(response: DraftProbeResponseT, slotId: string): SlotResponseT {
  switch (response.kind) {
    case 'select':
      return {
        slot_id: slotId,
        kind: 'select',
        state: response.state ?? 'answered',
        item_ids: response.item_ids ?? response.picked ?? [],
      };
    case 'blank':
      return {
        slot_id: slotId,
        kind: 'blank',
        state: response.state ?? 'answered',
        text: response.text,
      };
    case 'free':
      return {
        slot_id: slotId,
        kind: 'open',
        text_md: response.text_md,
        evidence: [],
      };
  }
}

function methodFingerprint(
  unit: DraftUnitForFingerprint | undefined,
  contractUnit: { criterion: unknown; rule?: unknown } | undefined,
  declaredAnswerShape: unknown,
): string {
  const canonical = canonicalJson({
    method: unit?.method ?? null,
    criterion: contractUnit?.criterion ?? null,
    rule: contractUnit?.rule ?? unit?.rule ?? null,
    material_refs: unit?.material_refs ?? [],
    // YUK-1568 第 2 片：已声明槽位的探针指纹携带 answer_shape 与比较器
    // 版本（声明/绑定/单位语义变化 ⇒ 新指纹）；无声明草稿不携带任何新字段
    // —— 旧指纹字节不变，既有校准/复用语义不受影响，不回填历史指纹。
    ...(declaredAnswerShape != null
      ? {
          answer_shape: declaredAnswerShape,
          declared_compare_version: DECLARED_BLANK_COMPARE_VERSION,
        }
      : {}),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

type DraftUnitForFingerprint = QuestionDraftDocumentT['parts'][number]['units'][number];

// ---------- legacy 投影辅助（提交路径/读取路径共用） ----------

export type { StructuredQuestionT };
export { draftDocumentToStructuredQuestion, isDraftDocumentV2, isLegacyStructuredQuestion };
