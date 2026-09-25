import type {
  AggregateOutcomeT,
  EvidenceAttachmentT,
  GroupEvidenceT,
  IssuedMaterialBindingT,
  IssuedOptionOrderT,
  PublishedQuestionRevisionT,
  ResponseSetT,
  ResponseSlotT,
  ScoringUnitResultT,
} from '../schema/assessment';
import {
  validateExecutionPlan,
  validateIssuanceBinding,
  validateResponseSet,
  validateResponseSpec,
  validateScoringBasis,
  validateStructure,
} from '../schema/assessment';
import { canonicalHash, shortHash } from './canonical';
import type {
  MigrationCapture,
  MigrationClassification,
  NativeCategory,
  RawAnswerRow,
  RawEventRow,
  RawSourceAssetRow,
  RecordClassification,
} from './types';

// ====================================================================
// YUK-1050 — 历史迁移 apply · 纯规划器（grounding §13、§15；review P1-3..P1-7）
// ====================================================================
//
// 输入：YUK-1048 capture + classification（manifest 持久化的完整分类输出）
//       + revision registry v2（语料导入 lane 的接缝工件：occurrence/snapshot
//         感知绑定）+ 目标库的 revision contracts（question_revision 行的五层
//         内容，由执行器装载后传入 —— 规划器保持纯函数）。
// 输出：MigrationApplyPlan —— 逐分类记录的确定性写意图（mapping /
//       issuance / group / submission / evaluation / effective head）。
//
// 纪律（grounding §13，不可弱化；review 后收紧）：
//   - 全量迁移 ≠ 批量历史重判：判词只作为 legacy 证据迁移（provenance），绝不
//     重算、绝不换算成发布侧 points（无获准映射 ⇒ unit 结果显式 pending，
//     aggregate unresolved/pending_units —— 不冒充 no_mapping 也不造假分）。
//   - 无冻结上下文 / 无法忠实重建 ⇒ historical_unresolved：revision 契约的
//     槽位形态无法承载 legacy 自由文本作答（choice/numeric/… 需要身份，legacy
//     无 stable option id / 数值解析即解释）、已接收图片证据缺资产元数据
//     （D5 零丢失）、registry 坐标与 revision 契约不符 —— 一律显式降级，绝不
//     产出一个「看似正常」的冻结 submission。
//   - imported evaluation 不激活 head（§11/D4：activation 需 settlement 同事务
//     生效；§13：切换前 replay 不足 ⇒ non-effective pending，不静默 applied）。
//     legacy 的 effective truth（newest-wince-wins head 选择）保留在 mapping
//     evidence.legacy_effective_truth。
//   - 无学习重放：plan 不含任何 FSRS/θ̂/calibration 写意图。
//
// 幂等基座：一切主键内容寻址派生（mapping_id 含裁决内容 —— pending→resolved
// 的 supersession 换行不换 id 冲突），同输入 ⇒ 同 plan 同 id 同 digest。

export const APPLY_ALGORITHM_VERSION = 'yuk1050-apply/1.1.0';

/** 获得身份映射行的分类类别（lineage 类别不产生映射行）。 */
const MAPPING_BEARING_CATEGORIES: ReadonlySet<NativeCategory> = new Set([
  'complete_attempt',
  'embedded_tutor_grade',
  'attribution_only',
  'attribution_pending_placeholder',
  'human_import_assertion',
  'pending_blocked',
  'historical_unresolved',
  'correction_cycle_unresolved',
]);

/** 产生 submission 链的分类类别（且仅当 revision 绑定已解析 + 契约可忠实重建）。 */
const SUBMISSION_BEARING_CATEGORIES: ReadonlySet<NativeCategory> = new Set([
  'complete_attempt',
  'embedded_tutor_grade',
]);

// ───────────────────────── revision registry v2（接缝工件） ─────────────────────────

export type RegistryBindingKind = 'snapshot_verified' | 'question_asserted';

/**
 * 语料导入（publisher/normalizer lane 或隔离演练产物）声明的 legacy → 新契约
 * 绑定。v2（review P1-4）：
 *   - occurrence/snapshot 感知：同一 legacy question 的多个历史版本可各绑不同
 *     revision/快照；多个 legacy question 也可绑同一 group revision 的不同 parts。
 *   - `snapshot_verified`：携带冻结 snapshot digest，解析时与历史记录自身的
 *     冻结 snapshot digest【逐一比对】—— 这是绑定为已验证的唯一途径。
 *   - `question_asserted`：显式、可审计的断言（缺历史证明时的唯一合法路径）；
 *     必须给出 assertion_reason，进 mapping evidence，绝不冒充已验证。
 *   - `scoring_unit_id` 必填：整题 legacy 判词必须可归属到唯一计分单元，
 *     否则 registry 拒绝（归属不明 ⇒ 不列绑定，不是规划器猜）。
 */
export interface RevisionRegistryEntry {
  question_id: string;
  revision_id: string;
  /** issuance 绑定的 part 子集（导入方声明；solo 题 = 单 part）。 */
  part_ids: string[];
  slot_id: string;
  scoring_unit_id: string;
  binding_kind: RegistryBindingKind;
  /** binding_kind=snapshot_verified 必填：冻结 snapshot 的 canonical digest。 */
  snapshot_digest: string | null;
  /** binding_kind=question_asserted 必填：断言理由（可审计）。 */
  assertion_reason: string | null;
  published_at: string | null;
}

export interface RevisionRegistry {
  registry_version: 2;
  generated_by: string;
  entries: RevisionRegistryEntry[];
}

export interface RegistryParseIssue {
  detail: string;
}

/** 解析 + 校验 registry v2 工件（fail-visible：任何形状问题都拒绝，不猜）。 */
export function parseRevisionRegistry(
  input: unknown,
): { ok: true; registry: RevisionRegistry } | { ok: false; issues: RegistryParseIssue[] } {
  const issues: RegistryParseIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ detail: 'registry 根必须是对象' }] };
  }
  const root = input as Record<string, unknown>;
  if (root.registry_version !== 2) {
    return {
      ok: false,
      issues: [
        {
          detail: `registry_version 必须为 2（得到 ${String(root.registry_version)}）—— v1（可空 snapshot_digest 的单题绑定）已被 review P1-4 废弃`,
        },
      ],
    };
  }
  if (typeof root.generated_by !== 'string' || root.generated_by.length === 0) {
    issues.push({ detail: 'generated_by 必须为非空字符串（工件来源可审计）' });
  }
  if (!Array.isArray(root.entries)) {
    issues.push({ detail: 'entries 必须为数组' });
    return { ok: false, issues };
  }
  const seenVerified = new Set<string>(); // question_id|snapshot_digest 唯一
  const seenAsserted = new Set<string>(); // question_id 唯一（一题一断言）
  const seenExact = new Set<string>(); // 完全重复拒绝
  const entries: RevisionRegistryEntry[] = [];
  for (const [idx, raw] of root.entries.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ detail: `entries[${idx}] 必须为对象` });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const questionId = entry.question_id;
    const revisionId = entry.revision_id;
    const partIds = entry.part_ids;
    const slotId = entry.slot_id;
    const scoringUnitId = entry.scoring_unit_id;
    const bindingKind = entry.binding_kind;
    if (typeof questionId !== 'string' || questionId.length === 0) {
      issues.push({ detail: `entries[${idx}].question_id 必须为非空字符串` });
      continue;
    }
    if (typeof revisionId !== 'string' || revisionId.length === 0) {
      issues.push({ detail: `entries[${idx}].revision_id 必须为非空字符串` });
      continue;
    }
    if (
      !Array.isArray(partIds) ||
      partIds.length === 0 ||
      partIds.some((p) => typeof p !== 'string' || p.length === 0)
    ) {
      issues.push({
        detail: `entries[${idx}].part_ids 必须为非空字符串数组（导入方声明 issuance 绑定子集）`,
      });
      continue;
    }
    if (typeof slotId !== 'string' || slotId.length === 0) {
      issues.push({ detail: `entries[${idx}].slot_id 必填（legacy 作答的槽位归属必须显式声明）` });
      continue;
    }
    if (typeof scoringUnitId !== 'string' || scoringUnitId.length === 0) {
      issues.push({
        detail: `entries[${idx}].scoring_unit_id 必填（整题 legacy 判词必须可归属到唯一计分单元）`,
      });
      continue;
    }
    if (bindingKind !== 'snapshot_verified' && bindingKind !== 'question_asserted') {
      issues.push({
        detail: `entries[${idx}].binding_kind 必须为 'snapshot_verified' 或 'question_asserted'`,
      });
      continue;
    }
    const snapshotDigest =
      typeof entry.snapshot_digest === 'string' && entry.snapshot_digest.length > 0
        ? entry.snapshot_digest
        : null;
    const assertionReason =
      typeof entry.assertion_reason === 'string' && entry.assertion_reason.length > 0
        ? entry.assertion_reason
        : null;
    if (bindingKind === 'snapshot_verified' && snapshotDigest === null) {
      issues.push({
        detail: `entries[${idx}] binding_kind=snapshot_verified 必须携带 snapshot_digest —— 缺历史证明只能走显式 question_asserted 断言`,
      });
      continue;
    }
    if (bindingKind === 'question_asserted' && assertionReason === null) {
      issues.push({
        detail: `entries[${idx}] binding_kind=question_asserted 必须携带 assertion_reason`,
      });
      continue;
    }
    const exactKey = `${questionId}|${revisionId}|${slotId}|${bindingKind}|${snapshotDigest ?? ''}`;
    if (seenExact.has(exactKey)) {
      issues.push({ detail: `entries[${idx}] 与既有条目完全重复（${exactKey}）` });
      continue;
    }
    seenExact.add(exactKey);
    if (bindingKind === 'snapshot_verified') {
      const verifiedKey = `${questionId}|${snapshotDigest}`;
      if (seenVerified.has(verifiedKey)) {
        issues.push({
          detail: `entries[${idx}] 同一 question 的同一 snapshot digest 有多条 snapshot_verified 绑定 —— 解析歧义，拒绝`,
        });
        continue;
      }
      seenVerified.add(verifiedKey);
    } else if (seenAsserted.has(questionId)) {
      issues.push({
        detail: `entries[${idx}] 同一 question 已有一条 question_asserted 断言 —— 一题一断言`,
      });
      continue;
    } else {
      seenAsserted.add(questionId);
    }
    entries.push({
      question_id: questionId,
      revision_id: revisionId,
      part_ids: partIds as string[],
      slot_id: slotId,
      scoring_unit_id: scoringUnitId,
      binding_kind: bindingKind,
      snapshot_digest: snapshotDigest,
      assertion_reason: assertionReason,
      published_at:
        typeof entry.published_at === 'string' && entry.published_at.length > 0
          ? entry.published_at
          : null,
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    registry: { registry_version: 2, generated_by: root.generated_by as string, entries },
  };
}

/** registry 工件的内容 digest（plan/run 身份的一部分）。 */
export function registryDigestOf(registry: RevisionRegistry | null): string | null {
  return registry === null ? null : canonicalHash(registry);
}

// ───────────────────────── 写意图类型 ─────────────────────────

export type MappingStatus = 'pending' | 'mapped' | 'conflicted' | 'historical_unresolved';

export interface MappingRowPlan {
  mapping_id: string;
  source_kind: string;
  source_id: string;
  source_locator: string;
  original_question_id: string;
  legacy_part_ref: string | null;
  snapshot_digest: string | null;
  target_revision_id: string | null;
  target_part_id: string | null;
  target_slot_id: string | null;
  evidence: Record<string, unknown>;
  algorithm_version: string;
  status: MappingStatus;
  created_at: Date;
  /** pending→resolved supersession（P1-5）：指向被本行接替的旧当前映射。 */
  supersedes_mapping_id: string | null;
}

export interface IssuanceRowPlan {
  issuance_id: string;
  revision_id: string;
  part_ids: string[];
  material_bindings: IssuedMaterialBindingT[];
  option_order: IssuedOptionOrderT[];
  container_occurrence_ref: string | null;
  claim_policy: 'unbounded';
  claim_status: 'unclaimed';
  claimed_by_ref: null;
  issued_at: Date;
}

export interface EvaluationGroupRowPlan {
  evaluation_group_id: string;
  submission_ids: string[];
  created_at: Date;
}

export interface SubmissionRowPlan {
  submission_id: string;
  issuance_id: string;
  revision_id: string;
  evaluation_group_id: string;
  response_set: ResponseSetT;
  group_evidence: GroupEvidenceT[];
  idempotency_key: string;
  submitted_at: Date;
}

export interface EvaluationRowPlan {
  evaluation_id: string;
  evaluation_group_id: string;
  submission_id: string;
  attempt: number;
  status: 'completed';
  unit_results: ScoringUnitResultT[];
  aggregate: AggregateOutcomeT;
  plan_digest: null;
  run_refs: string[];
  provenance: Record<string, unknown>;
  created_at: Date;
}

export interface EffectiveHeadRowPlan {
  evaluation_group_id: string;
  submission_id: string;
  /**
   * 迁移导入的 evaluation 一律不激活 head（§11/D4：activation 需 settlement
   * 同事务；§13：non-effective pending）—— head 行随 submission 建立，保持
   * effective=NULL、generation=0，由 settlement lane 在获准规则下激活。
   */
  effective_evaluation_id: null;
  generation: 0;
  updated_at: Date;
}

export interface SubmissionChainPlan {
  anchor_locator: string;
  issuance: IssuanceRowPlan;
  group: EvaluationGroupRowPlan;
  submission: SubmissionRowPlan;
  evaluations: EvaluationRowPlan[];
  head: EffectiveHeadRowPlan;
}

export interface ApplyRecordIntent {
  classification: RecordClassification;
  /** lineage-only 类别无映射行。 */
  mapping: MappingRowPlan | null;
  /** anchor 记录且 revision 已解析 + 契约可忠实重建时携带 submission 链。 */
  submission: SubmissionChainPlan | null;
}

export interface AwaitingRegistryEntry {
  source_locator: string;
  original_question_id: string;
  category: NativeCategory;
  reason: string;
}

export interface ConflictedEntry {
  source_locator: string;
  original_question_id: string;
  reason: string;
}

/** live draft（submitted_at IS NULL 的 answer 行）的显式处置清单（P1-7）。 */
export interface LiveDraftEntry {
  source_locator: string;
  question_id: string;
  answer_id: string;
  disposition: 'preserved-in-legacy-awaiting-autosave-migration';
}

/** 忠实重建被阻断的 anchor（P1-6）：显式降级清单，绝不产看似正常的冻结 submission。 */
export interface ReconstructionBlockedEntry {
  source_locator: string;
  original_question_id: string;
  reason: string;
}

export interface MigrationApplyPlanWorklists {
  unresolved: MigrationClassification['unresolved'];
  deferred_replay: MigrationClassification['deferred_replay'];
  awaiting_revision_registry: AwaitingRegistryEntry[];
  conflicted: ConflictedEntry[];
  live_drafts: LiveDraftEntry[];
  reconstruction_blocked: ReconstructionBlockedEntry[];
}

export interface MigrationApplyPlan {
  plan_version: 2;
  checkpoint_hash: string;
  classification_version: string;
  classification_hash: string;
  registry_digest: string | null;
  algorithm_version: string;
  records: ApplyRecordIntent[];
  /** 每 category：记录数 / 映射行 / submission 链 / evaluation。 */
  rollup: {
    per_category: Record<
      string,
      { records: number; mappings: number; submissions: number; evaluations: number }
    >;
    mapping_status: Record<MappingStatus, number>;
    totals: { records: number; mappings: number; submissions: number; evaluations: number };
  };
  worklists: MigrationApplyPlanWorklists;
}

/**
 * plan digest 覆盖【完整行内容】（review P1-3）：改任何 planned 响应/证据/
 * 判词映射都改变 digest —— 同 run 混入不同 plan 的写入被账本当场拒绝。
 */
export function planDigestOf(plan: MigrationApplyPlan): string {
  return canonicalHash({
    plan_version: plan.plan_version,
    checkpoint_hash: plan.checkpoint_hash,
    classification_hash: plan.classification_hash,
    registry_digest: plan.registry_digest,
    algorithm_version: plan.algorithm_version,
    records: plan.records.map((r) => ({
      locator: r.classification.source_locator,
      mapping: r.mapping,
      submission: r.submission,
    })),
  });
}

/** 单条 mapping 行内容 digest（对账用：库内行 vs plan 行逐字节比对；
 * supersedes_mapping_id 是 pending→resolved 过渡簿记，不参与内容对账）。 */
export function mappingRowDigest(row: {
  source_kind: unknown;
  source_id: unknown;
  source_locator: unknown;
  original_question_id: unknown;
  legacy_part_ref: unknown;
  snapshot_digest: unknown;
  target_revision_id: unknown;
  target_part_id: unknown;
  target_slot_id: unknown;
  evidence: unknown;
  algorithm_version: unknown;
  status: unknown;
  created_at?: unknown;
}): string {
  return canonicalHash({
    source_kind: row.source_kind,
    source_id: row.source_id,
    source_locator: row.source_locator,
    original_question_id: row.original_question_id,
    legacy_part_ref: row.legacy_part_ref,
    snapshot_digest: row.snapshot_digest,
    target_revision_id: row.target_revision_id,
    target_part_id: row.target_part_id,
    target_slot_id: row.target_slot_id,
    evidence: row.evidence,
    algorithm_version: row.algorithm_version,
    status: row.status,
    created_at: row.created_at,
  });
}

export function applyRunIdOf(input: {
  checkpoint_hash: string;
  classification_hash: string;
  registry_digest: string | null;
}): string {
  return `run-${shortHash(canonicalHash(input), 24)}`;
}

// ───────────────────────── 内部工具 ─────────────────────────

interface EventPayload {
  [key: string]: unknown;
}

function payloadOf(payload: unknown): EventPayload {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as EventPayload)
    : {};
}

function idOf(prefix: string, ...parts: string[]): string {
  return `${prefix}-${canonicalHash(parts.join('\u0000')).slice(0, 32)}`;
}

function toDate(iso: string | null | undefined, fallback: Date): Date {
  if (typeof iso !== 'string' || iso.length === 0) return fallback;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 冻结作答输入的 digest（P1-7：覆盖真实 pending 输入面 —— 题身/时间/正文/图片）。 */
export function responseDigestOf(input: {
  question_id: string | null;
  submitted_at: string | null;
  response_md: string | null;
  image_refs: string[];
}): string {
  return canonicalHash({
    question_id: input.question_id,
    submitted_at: input.submitted_at,
    response_md: input.response_md,
    image_refs: [...input.image_refs].sort(),
  });
}

/** 分类记录的冻结 snapshot（attempt 事件 / durable pending submit）与 digest。 */
function frozenSnapshotOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
  pendingByRunId: Map<string, RawEventRow>,
): {
  snapshot: unknown;
  digest: string | null;
} {
  if (record.source_kind !== 'event') return { snapshot: null, digest: null };
  const event = eventById.get(record.source_id);
  if (event === undefined) return { snapshot: null, digest: null };
  const payload = payloadOf(event.payload);
  if (event.action === 'attempt') {
    const snapshot = payload.question_snapshot ?? null;
    return { snapshot, digest: snapshot == null ? null : canonicalHash(snapshot) };
  }
  if (event.action === 'review') {
    // durable 回填 review 的冻结输入在 pending 事件的 submit.question_snapshot；
    // 绑定键是 payload.run_id === review.id（与分类器同构，evidence id 去重不可靠）。
    const pending = pendingByRunId.get(event.id);
    if (pending === undefined) return { snapshot: null, digest: null };
    const submit = payloadOf(payloadOf(pending.payload).submit);
    const snapshot = submit.question_snapshot ?? null;
    return { snapshot, digest: snapshot == null ? null : canonicalHash(snapshot) };
  }
  if (event.action === 'experimental:judge_pending_attempt') {
    // 未回填 run 的冻结输入本体（缺件 pending 仍有权做 digest 对照）。
    const submit = payloadOf(payload.submit);
    const snapshot = submit.question_snapshot ?? null;
    return { snapshot, digest: snapshot == null ? null : canonicalHash(snapshot) };
  }
  return { snapshot: null, digest: null };
}

/** judge 事件锚定的作答锚事件（attempt/review）；非 judge 记录返回 null。 */
function anchorEventOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
): RawEventRow | null {
  if (record.source_kind !== 'event') return null;
  const event = eventById.get(record.source_id);
  if (event === undefined || event.action !== 'judge' || event.subject_kind !== 'event')
    return null;
  return eventById.get(event.subject_id) ?? null;
}

/** 记录指向的 legacy question id（尽力诚实解析；无法解析时显式标注）。 */
function originalQuestionIdOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
  answerById: Map<string, RawAnswerRow>,
): string {
  if (record.source_kind === 'answer') {
    return answerById.get(record.source_id)?.question_id ?? `unknown:answer:${record.source_id}`;
  }
  const event = eventById.get(record.source_id);
  if (event === undefined) return `unknown:event:${record.source_id}`;
  if (event.subject_kind === 'question') return event.subject_id;
  if (event.action === 'judge' && event.subject_kind === 'event') {
    const anchor = eventById.get(event.subject_id);
    if (anchor !== undefined && anchor.subject_kind === 'question') return anchor.subject_id;
  }
  return `unresolved-ref:${event.subject_kind}:${event.subject_id}`;
}

/**
 * legacy 作答输入（P1-7 修正）：attempt/review 事件读顶层 answer_image_refs；
 * durable pending 读 submit.body.*（CreateAttemptBody 冻结面 —— 图片在
 * body.answer_image_refs，不在 payload 顶层）。
 */
function legacyResponseOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
  pendingByRunId: Map<string, RawEventRow>,
): {
  question_id: string | null;
  response_md: string | null;
  image_refs: string[];
  submitted_at: string | null;
  caller: string | null;
  knowledge_ids: string[];
} {
  if (record.source_kind !== 'event') {
    return {
      question_id: null,
      response_md: null,
      image_refs: [],
      submitted_at: null,
      caller: null,
      knowledge_ids: [],
    };
  }
  const event = eventById.get(record.source_id);
  if (event === undefined) {
    return {
      question_id: null,
      response_md: null,
      image_refs: [],
      submitted_at: null,
      caller: null,
      knowledge_ids: [],
    };
  }
  const payload = payloadOf(event.payload);
  if (event.action === 'attempt') {
    return {
      question_id: event.subject_kind === 'question' ? event.subject_id : null,
      response_md: typeof payload.answer_md === 'string' ? payload.answer_md : null,
      image_refs: stringArray(payload.answer_image_refs),
      submitted_at: event.created_at,
      caller: null,
      knowledge_ids: stringArray(payload.referenced_knowledge_ids),
    };
  }
  if (event.action === 'review') {
    // durable 回填：提交时刻以 pending submit 冻结的 submitted_at 为准。
    const pending = pendingByRunId.get(event.id);
    const submit = pending === undefined ? {} : payloadOf(payloadOf(pending.payload).submit);
    const submitAt = typeof submit.submitted_at === 'string' ? submit.submitted_at : null;
    return {
      question_id: event.subject_kind === 'question' ? event.subject_id : null,
      response_md: typeof payload.user_response_md === 'string' ? payload.user_response_md : null,
      image_refs: stringArray(payload.answer_image_refs),
      submitted_at: submitAt ?? event.created_at,
      caller: null,
      knowledge_ids: stringArray(payload.referenced_knowledge_ids),
    };
  }
  if (event.action === 'experimental:judge_pending_attempt') {
    // 冻结输入本体：submit.body 是 CreateAttemptBody（response_md +
    // answer_image_refs 在 body 层），question_id/submitted_at 在 submit 层。
    const submit = payloadOf(payload.submit);
    const body = payloadOf(submit.body);
    return {
      question_id: typeof submit.question_id === 'string' ? submit.question_id : null,
      response_md: typeof body.response_md === 'string' ? body.response_md : null,
      image_refs: stringArray(body.answer_image_refs),
      submitted_at:
        typeof submit.submitted_at === 'string' ? submit.submitted_at : event.created_at,
      caller: typeof payload.caller === 'string' ? payload.caller : null,
      knowledge_ids: stringArray(payload.knowledge_ids),
    };
  }
  return {
    question_id: null,
    response_md: null,
    image_refs: [],
    submitted_at: null,
    caller: null,
    knowledge_ids: [],
  };
}

/** pending 的显式恢复信封（§13：保留 run/request/pending 身份 + 送达处置）。 */
function pendingRecoveryEnvelopeOf(
  response: ReturnType<typeof legacyResponseOf>,
  runId: string | null,
  queues: MigrationCapture['queues'],
): Record<string, unknown> {
  const judgeRunQueues = queues
    .filter((q) => q.name === 'judge_run')
    .map((q) => ({ state: q.state, count: q.count }));
  return {
    run_id: runId,
    caller: response.caller,
    knowledge_ids: response.knowledge_ids,
    frozen_request: {
      question_id: response.question_id,
      submitted_at: response.submitted_at,
      response_md: response.response_md,
      answer_image_refs: response.image_refs,
    },
    eval_generation: 0,
    delivery_disposition: { judge_run_queues: judgeRunQueues },
    backfill_event_id: runId !== null ? runId : null,
    note: 'durable judge run 未回填 —— 保留 run/request/pending 身份与冻结输入，恢复走正道回填/重派，不在此处判分',
  };
}

/** source_asset 行 → 契约原生 EvidenceAttachment（digest/mime/bytes 齐备才忠实）。 */
function evidenceAttachmentOf(asset: RawSourceAssetRow): EvidenceAttachmentT {
  const kindByMime: (mime: string) => EvidenceAttachmentT['kind'] = (mime) => {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'pdf';
    return 'plaintext';
  };
  return {
    evidence_id: `legacy-${asset.id}`,
    kind: kindByMime(asset.mime_type),
    asset: { asset_id: asset.id, digest: asset.sha256 },
    mime_type: asset.mime_type,
    bytes: asset.byte_size,
    uploaded_at: asset.created_at,
  };
}

// ───────────────────────── 规划器主体 ─────────────────────────

export interface BuildApplyPlanInput {
  capture: MigrationCapture;
  classification: {
    classification_version: string;
    classification_hash: string;
    records: RecordClassification[];
    unresolved: MigrationClassification['unresolved'];
    deferred_replay: MigrationClassification['deferred_replay'];
  };
  checkpoint_hash: string;
  registry: RevisionRegistry | null;
  /** 目标库 question_revision 行的五层契约（执行器装载；规划器保持纯函数）。 */
  revisionContracts: ReadonlyMap<string, PublishedQuestionRevisionT>;
  algorithm_version?: string;
}

interface Resolution {
  status: MappingStatus;
  entry: RevisionRegistryEntry | null;
  reason: string;
  binding: 'digest_verified' | 'question_asserted' | null;
}

/**
 * 分类输出 → 确定性写意图。同输入 ⇒ 同 plan（同 id、同 digest、同行内容）
 * —— 这是 apply 幂等与 crash 续跑的基础：一切主键都是内容寻址派生，
 * 重放不产生新行。mapping_id 含裁决内容（status+target），pending→resolved
 * 的 supersession 新裁决产生新行（旧行 is_current=false 保留历史）。
 */
export function buildMigrationApplyPlan(input: BuildApplyPlanInput): MigrationApplyPlan {
  const algorithmVersion = input.algorithm_version ?? APPLY_ALGORITHM_VERSION;
  const eventById = new Map(input.capture.rawFacts.events.map((e) => [e.id, e] as const));
  const answerById = new Map(input.capture.rawFacts.answers.map((a) => [a.id, a] as const));
  const assetsById = new Map(input.capture.rawFacts.source_assets.map((a) => [a.id, a] as const));
  const registryByQuestion =
    input.registry === null
      ? new Map<string, RevisionRegistryEntry[]>()
      : groupEntriesByQuestion(input.registry.entries);
  const fallbackTime = new Date(input.capture.environment.snapshot_at);
  // durable pending 索引：payload.run_id → pending 事件（与分类器同构的绑定键）。
  const pendingByRunId = new Map<string, RawEventRow>();
  for (const candidate of input.capture.rawFacts.events) {
    if (candidate.action !== 'experimental:judge_pending_attempt') continue;
    const runId = payloadOf(candidate.payload).run_id;
    if (typeof runId === 'string' && !pendingByRunId.has(runId))
      pendingByRunId.set(runId, candidate);
  }

  // judge 记录按锚聚合（分类输出为唯一真相；这里只做分组，不重新分类）。
  const judgeRecordsByAnchor = new Map<string, RecordClassification[]>();
  for (const record of input.classification.records) {
    if (record.source_kind !== 'event') continue;
    const event = eventById.get(record.source_id);
    if (event === undefined || event.action !== 'judge' || event.subject_kind !== 'event') continue;
    const list = judgeRecordsByAnchor.get(event.subject_id) ?? [];
    list.push(record);
    judgeRecordsByAnchor.set(event.subject_id, list);
  }

  const intents: ApplyRecordIntent[] = [];
  const awaitingRegistry: AwaitingRegistryEntry[] = [];
  const conflicted: ConflictedEntry[] = [];
  const reconstructionBlocked: ReconstructionBlockedEntry[] = [];
  const liveDrafts: LiveDraftEntry[] = [];
  const mappingStatusCount: Record<MappingStatus, number> = {
    pending: 0,
    mapped: 0,
    conflicted: 0,
    historical_unresolved: 0,
  };
  const resolutionByLocator = new Map<string, Resolution>();

  /** registry v2 解析（P1-4）：snapshot 逐一对照 + 显式断言 + 漂移/缺证明分支。 */
  const resolveAgainstRegistry = (
    originalQuestionId: string,
    snapshotDigest: string | null,
  ): Resolution => {
    const candidates = registryByQuestion.get(originalQuestionId) ?? [];
    if (candidates.length === 0) {
      return {
        status: 'pending',
        entry: null,
        reason: 'revision registry 无该题绑定 —— 身份待语料导入后解析',
        binding: null,
      };
    }
    if (snapshotDigest !== null) {
      const exact = candidates.find(
        (c) => c.binding_kind === 'snapshot_verified' && c.snapshot_digest === snapshotDigest,
      );
      if (exact !== undefined) {
        return {
          status: 'mapped',
          entry: exact,
          reason: '冻结 snapshot digest 与 registry snapshot_verified 绑定逐一一致 —— 绑定已验证',
          binding: 'digest_verified',
        };
      }
    }
    const asserted = candidates.find((c) => c.binding_kind === 'question_asserted');
    if (asserted !== undefined) {
      return {
        status: 'mapped',
        entry: asserted,
        reason: `registry question_asserted 显式断言：${asserted.assertion_reason ?? ''}（可审计，非 digest 验证）`,
        binding: 'question_asserted',
      };
    }
    if (snapshotDigest === null) {
      return {
        status: 'pending',
        entry: null,
        reason:
          '该记录无冻结 snapshot digest 可与 registry 的 snapshot_verified 绑定对照，且无显式断言 —— 不猜',
        binding: null,
      };
    }
    return {
      status: 'conflicted',
      entry: null,
      reason: `冻结 snapshot digest 与该题全部 snapshot_verified 绑定不符（记录 ${snapshotDigest.slice(0, 12)}）—— 内容漂移，不得绑定`,
      binding: null,
    };
  };

  // 阶段 1（分两遍，P1-6/P1-4 一致性）：先解析【非镜像】记录（attempt/review
  // 锚、pending 事件等），随后做锚的忠实重建（降级会改写锚的裁决），最后才
  // 解析 judge/answer 镜像 —— 镜像继承的是锚【最终】裁决（含降级），不会出现
  // 锚 historical 而镜像 mapped 的分叉。
  const mirrorRecords: RecordClassification[] = [];
  const buildRecordIntent = (record: RecordClassification): void => {
    if (!MAPPING_BEARING_CATEGORIES.has(record.category)) {
      if (record.category === 'live_draft' && record.source_kind === 'answer') {
        const answerRow = answerById.get(record.source_id);
        liveDrafts.push({
          source_locator: record.source_locator,
          question_id: answerRow?.question_id ?? `unknown:${record.source_id}`,
          answer_id: record.source_id,
          disposition: 'preserved-in-legacy-awaiting-autosave-migration',
        });
      }
      intents.push({ classification: record, mapping: null, submission: null });
      return;
    }
    const originalQuestionId = originalQuestionIdOf(record, eventById, answerById);
    const anchorEvent = anchorEventOf(record, eventById);
    const { digest: snapshotDigest } = frozenSnapshotOf(record, eventById, pendingByRunId);
    const answerRow =
      record.source_kind === 'answer' ? answerById.get(record.source_id) : undefined;
    const anchorCreatedIso =
      anchorEvent?.created_at ??
      eventById.get(record.source_id)?.created_at ??
      answerRow?.submitted_at ??
      null;
    const createdAt = toDate(anchorCreatedIso, fallbackTime);

    let resolution: Resolution;
    // judge / answer 镜像记录继承其锚 occurrence 的裁决（分类器已保证锚与
    // 镜像判定一致）：锚 conflicted/pending/降级 时，镜像不得独立绕过锚。
    let resolutionAnchor: RawEventRow | null = anchorEvent;
    if (resolutionAnchor === null && answerRow?.event_id != null) {
      const linked = eventById.get(answerRow.event_id);
      if (linked !== undefined && (linked.action === 'attempt' || linked.action === 'review')) {
        resolutionAnchor = linked;
      }
    }
    const anchorResolution =
      resolutionAnchor !== null
        ? resolutionByLocator.get(`event:${resolutionAnchor.action}:${resolutionAnchor.id}`)
        : undefined;
    if (record.category === 'historical_unresolved') {
      resolution = {
        status: 'historical_unresolved',
        entry: null,
        reason: '缺冻结上下文 —— 身份不可解析（§13：不得用当前题面补造当时所见）',
        binding: null,
      };
    } else if (record.category === 'correction_cycle_unresolved') {
      resolution = {
        status: 'conflicted',
        entry: null,
        reason: '纠正链闭包成员 —— 多个竞争 effective-truth，保持 conflicted/unresolved',
        binding: null,
      };
    } else if (anchorResolution !== undefined) {
      resolution = {
        ...anchorResolution,
        reason: `继承锚 occurrence（${resolutionAnchor !== null ? resolutionAnchor.id : ''}）的裁决：${anchorResolution.reason}`,
      };
      // worklist（awaiting/conflicted/reconstruction_blocked）以锚记录为代表。
    } else {
      resolution = resolveAgainstRegistry(originalQuestionId, snapshotDigest);
      if (resolution.status === 'pending') {
        awaitingRegistry.push({
          source_locator: record.source_locator,
          original_question_id: originalQuestionId,
          category: record.category,
          reason: resolution.reason,
        });
      } else if (resolution.status === 'conflicted') {
        conflicted.push({
          source_locator: record.source_locator,
          original_question_id: originalQuestionId,
          reason: resolution.reason,
        });
      }
    }
    resolutionByLocator.set(record.source_locator, resolution);
    mappingStatusCount[resolution.status] += 1;

    const evidence: Record<string, unknown> = {
      category: record.category,
      reason: record.reason,
      evidence_event_ids: record.evidence_event_ids,
      native_target: record.native_target,
      resolution: {
        status: resolution.status,
        reason: resolution.reason,
        binding: resolution.binding,
      },
      migration: {
        tool: 'yuk1050-apply',
        algorithm_version: algorithmVersion,
        classification_version: input.classification.classification_version,
      },
    };
    if (resolution.entry?.binding_kind === 'question_asserted') {
      evidence.registry_assertion = {
        asserted_by: input.registry?.generated_by ?? null,
        reason: resolution.entry.assertion_reason,
      };
    }
    if (snapshotDigest !== null) evidence.snapshot_digest = snapshotDigest;
    if (record.category === 'pending_blocked' && record.native_target.kind === 'pending_carried') {
      evidence.pending = record.native_target.pending;
      const response = legacyResponseOf(record, eventById, pendingByRunId);
      evidence.response_digest = responseDigestOf(response);
      const event = record.source_kind === 'event' ? eventById.get(record.source_id) : undefined;
      const runId = event !== undefined ? (payloadOf(event.payload).run_id as unknown) : undefined;
      const runIdStr = typeof runId === 'string' ? runId : null;
      if (runIdStr !== null && event !== undefined) {
        evidence.pending_recovery = pendingRecoveryEnvelopeOf(
          response,
          runIdStr,
          input.capture.queues,
        );
      }
    }
    if (
      record.category === 'historical_unresolved' &&
      record.native_target.kind === 'historical_unknown'
    ) {
      evidence.historical_unknown = record.native_target.record;
    }
    if (
      record.category === 'human_import_assertion' &&
      record.native_target.kind === 'manual_provenance_only'
    ) {
      evidence.manual_assertion = record.native_target.assertion;
    }
    if (
      record.category === 'attribution_only' ||
      record.category === 'attribution_pending_placeholder'
    ) {
      evidence.attribution_only = true;
    }
    if (record.native_target.kind === 'submission_with_imported_eval') {
      evidence.legacy_effective_truth = {
        head_selection: record.native_target.head_selection,
        judge_event_id: record.native_target.judge_event_id,
        has_effective_head: record.native_target.has_effective_head,
      };
    }

    intents.push({
      classification: record,
      mapping: {
        mapping_id: idOf(
          'amp',
          record.source_kind,
          record.source_id,
          record.source_locator,
          resolution.status,
          resolution.entry?.revision_id ?? '',
        ),
        source_kind: record.source_kind,
        source_id: record.source_id,
        source_locator: record.source_locator,
        original_question_id: originalQuestionId,
        legacy_part_ref: answerRow?.part_ref ?? null,
        snapshot_digest: snapshotDigest,
        target_revision_id:
          resolution.status === 'mapped' ? (resolution.entry?.revision_id ?? null) : null,
        target_part_id:
          resolution.status === 'mapped'
            ? selectTargetPart(resolution.entry, answerRow?.part_ref ?? null)
            : null,
        target_slot_id: resolution.status === 'mapped' ? (resolution.entry?.slot_id ?? null) : null,
        evidence,
        algorithm_version: algorithmVersion,
        status: resolution.status,
        created_at: createdAt,
        supersedes_mapping_id: null, // 由执行器在 pending→resolved 接替时回填
      },
      submission: null,
    });
  };

  // pass 1：非镜像记录。
  for (const record of input.classification.records) {
    const isJudgeMirror =
      record.source_kind === 'event' && anchorEventOf(record, eventById) !== null;
    const isAnswerMirror = record.source_kind === 'answer';
    if (isJudgeMirror || isAnswerMirror) {
      mirrorRecords.push(record);
      continue;
    }
    buildRecordIntent(record);
  }

  // 阶段 2：anchor 记录（complete_attempt / embedded_tutor_grade 且映射 mapped）
  // → 忠实重建 submission 链；无法忠实重建 ⇒ 显式降级 historical_unresolved。
  for (const intent of intents) {
    const record = intent.classification;
    if (record.source_kind !== 'event') continue;
    const event = eventById.get(record.source_id);
    if (event === undefined) continue;
    const isAnchor =
      (event.action === 'attempt' || event.action === 'review') &&
      event.subject_kind === 'question';
    if (!isAnchor || !SUBMISSION_BEARING_CATEGORIES.has(record.category)) continue;
    const resolution = resolutionByLocator.get(record.source_locator);
    if (resolution == null || resolution.status !== 'mapped' || resolution.entry == null) continue;

    /** 忠实重建被阻断：锚降级 historical_unresolved（镜像经 inheritance 同步）。 */
    const degrade = (reason: string): void => {
      const blocked: ReconstructionBlockedEntry = {
        source_locator: record.source_locator,
        original_question_id:
          event.subject_kind === 'question' ? event.subject_id : `unknown:${record.source_id}`,
        reason,
      };
      reconstructionBlocked.push(blocked);
      resolutionByLocator.set(record.source_locator, {
        status: 'historical_unresolved',
        entry: null,
        reason: `忠实重建被阻断：${reason}`,
        binding: null,
      });
      mappingStatusCount.mapped -= 1;
      mappingStatusCount.historical_unresolved += 1;
      if (intent.mapping !== null) {
        intent.mapping.status = 'historical_unresolved';
        intent.mapping.target_revision_id = null;
        intent.mapping.target_part_id = null;
        intent.mapping.target_slot_id = null;
        // mapping_id 含裁决内容 —— 降级后是新裁决（同输入确定性不变）。
        intent.mapping.mapping_id = idOf(
          'amp',
          record.source_kind,
          record.source_id,
          record.source_locator,
          'historical_unresolved',
          '',
        );
        intent.mapping.evidence.resolution = {
          status: 'historical_unresolved',
          reason: blocked.reason,
          binding: null,
        };
        intent.mapping.evidence.reconstruction_blocked = reason;
        intent.mapping.evidence.verified_binding_attempt = {
          revision_id: resolution.entry?.revision_id ?? null,
          binding: resolution.binding,
        };
      }
    };

    const entry = resolution.entry;
    const contract = input.revisionContracts.get(entry.revision_id);
    if (contract === undefined) {
      degrade(
        `revision ${entry.revision_id} 的五层契约未随 plan 提供（语料导入/装载不完整）—— 无法忠实重建 issuance/response`,
      );
      continue;
    }
    // 契约自身有效性（发布 barrier 的确定性子集 —— 语料导入坏了在这里显形）。
    const contractIssues = [
      ...validateStructure(contract.structure),
      ...validateResponseSpec(contract.response_spec, contract.structure),
      ...validateScoringBasis(contract.scoring_basis, contract.response_spec, contract.structure),
      ...validateExecutionPlan(contract.execution_plan, contract.scoring_basis),
    ];
    if (contractIssues.length > 0) {
      degrade(
        `revision 契约校验失败：${contractIssues.map((i) => `${i.code}(${'detail' in i ? i.detail : ''})`).join('; ')}`,
      );
      continue;
    }
    // registry 坐标与契约一致（P1-4）。
    const contractParts = new Set(contract.structure.parts.map((p) => p.part_id));
    if (!entry.part_ids.every((p) => contractParts.has(p))) {
      degrade(
        `registry part_ids 与 revision 契约不符（${entry.part_ids.join(',')} vs 契约 parts ${[...contractParts].join(',')}）`,
      );
      continue;
    }
    const slot = contract.response_spec.slots.find((s) => s.slot_id === entry.slot_id);
    if (slot === undefined || !entry.part_ids.includes(slot.part_id)) {
      degrade(`registry slot_id '${entry.slot_id}' 不在 revision 契约的发出 part 范围内`);
      continue;
    }
    if (!contract.scoring_basis.units.some((u) => u.scoring_unit_id === entry.scoring_unit_id)) {
      degrade(
        `registry scoring_unit_id '${entry.scoring_unit_id}' 不在 revision 契约的计分单元集内`,
      );
      continue;
    }

    // 忠实 response 绑定：legacy 整题自由文本（+图片）只能落【单一 text/open 槽】。
    const slotsInScope = contract.response_spec.slots.filter((s) =>
      entry.part_ids.includes(s.part_id),
    );
    const response = legacyResponseOf(record, eventById, pendingByRunId);
    const soleSlot = slotsInScope[0];
    if (soleSlot === undefined || soleSlot.slot_id !== entry.slot_id) {
      degrade(
        `发出范围内有 ${slotsInScope.length} 个槽位 —— legacy 整题自由文本作答无法归属（需唯一槽位绑定，不猜）`,
      );
      continue;
    }
    if (slot.kind !== 'text' && slot.kind !== 'open_response') {
      degrade(
        `槽位 kind='${slot.kind}' 需要选项/数值/配对身份，legacy 自由文本无法忠实重建（不得伪造 option/numeric identity）`,
      );
      continue;
    }
    const attachments: EvidenceAttachmentT[] = [];
    const missingAssets: string[] = [];
    for (const ref of response.image_refs) {
      const asset = assetsById.get(ref);
      if (asset === undefined) missingAssets.push(ref);
      else attachments.push(evidenceAttachmentOf(asset));
    }
    if (missingAssets.length > 0) {
      degrade(
        `已接收图片证据缺 source_asset 元数据（${missingAssets.join(',')}）—— D5 零丢失：不得静默丢附件`,
      );
      continue;
    }
    if (slot.kind === 'text' && attachments.length > 0) {
      degrade('text 槽不能承载证据附件，且已接收图片不得丢弃（D5）—— 需要 open_response 槽位契约');
      continue;
    }
    const responseSet: ResponseSetT = {
      entries: [
        slot.kind === 'open_response'
          ? {
              slot_id: slot.slot_id,
              kind: 'open',
              text_md: response.response_md ?? '',
              evidence: attachments,
            }
          : { slot_id: slot.slot_id, kind: 'text', text_md: response.response_md ?? '' },
      ],
    };
    const responseIssues = validateResponseSet(contract.response_spec, responseSet);
    if (responseIssues.length > 0) {
      degrade(
        `重建 response_set 未过契约校验：${responseIssues.map((i) => `${i.code}(${i.detail})`).join('; ')}`,
      );
      continue;
    }

    // issuance 绑定（P1-6）：materials 来自契约（同版资产 digest）；发出范围内
    // 的选择槽给声明序 option_order（此路径下 scope 无选择槽 —— 由校验兜底）。
    const boundPartIds = new Set(entry.part_ids);
    const boundMaterials = contract.structure.materials
      .filter((m) =>
        contract.structure.parts.some(
          (p) => boundPartIds.has(p.part_id) && p.material_ids.includes(m.material_id),
        ),
      )
      .map((m) => ({ material_id: m.material_id, asset_digest: m.asset.digest }));
    const optionOrder: IssuedOptionOrderT[] = contract.response_spec.slots
      .filter(
        (s): s is Extract<ResponseSlotT, { kind: 'single_choice' | 'multi_choice' | 'matching' }> =>
          (s.kind === 'single_choice' || s.kind === 'multi_choice' || s.kind === 'matching') &&
          boundPartIds.has(s.part_id),
      )
      .map((s) => ({
        slot_id: s.slot_id,
        option_ids: (s.kind === 'matching' ? s.right_options : s.options).map((o) => o.option_id),
      }));
    const issuance = {
      revision_id: entry.revision_id,
      part_ids: [...entry.part_ids],
      material_bindings: boundMaterials,
      option_order: optionOrder,
    };
    const issuanceIssues = validateIssuanceBinding(issuance, contract);
    if (issuanceIssues.length > 0) {
      degrade(
        `重建 issuance 绑定未过契约校验：${issuanceIssues.map((i) => `${i.code}(${i.detail})`).join('; ')}`,
      );
      continue;
    }

    const anchorId = record.source_id;
    const groupId = idOf('aeg', `group|${anchorId}`);
    const submissionId = idOf('asb', `submission|${anchorId}`);
    const issuanceId = idOf('ais', `issuance|${anchorId}|${entry.revision_id}`);
    const submittedAt = toDate(response.submitted_at, fallbackTime);

    // evaluation 候选：配对 verdict judge（分类输出）+ 嵌入判词。判词只作
    // legacy 证据迁移 —— unit 结果显式 pending（无获准 points 映射，P2）。
    interface EvalCandidate {
      evaluation_id: string;
      run_refs: string[];
      created_at: Date;
      coarse_outcome: unknown;
      score: unknown;
      feedback_md: string | null;
      provenance_note: Record<string, unknown>;
    }
    const candidates: EvalCandidate[] = [];
    for (const judgeRecord of judgeRecordsByAnchor.get(anchorId) ?? []) {
      if (judgeRecord.native_target.kind !== 'submission_with_imported_eval') continue;
      const judgeEvent = eventById.get(judgeRecord.source_id);
      if (judgeEvent === undefined) continue;
      const judgePayload = payloadOf(judgeEvent.payload);
      candidates.push({
        evaluation_id: idOf('aev', `evaluation|${anchorId}|${judgeRecord.source_id}`),
        run_refs: [judgeRecord.source_id],
        created_at: toDate(judgeEvent.created_at, submittedAt),
        coarse_outcome: judgePayload.coarse_outcome,
        score: judgePayload.score,
        feedback_md: typeof judgePayload.feedback_md === 'string' ? judgePayload.feedback_md : null,
        provenance_note: {
          judge_event_id: judgeRecord.source_id,
          head_selection: judgeRecord.native_target.head_selection,
          is_legacy_effective_head: judgeRecord.native_target.has_effective_head,
        },
      });
    }
    const payload = payloadOf(event.payload);
    let embedded: { coarse: unknown; score: unknown; feedback: string | null } | null = null;
    if (event.action === 'attempt' && payload.source === 'solve_tutor') {
      const judgeBlock = payloadOf(payload.judge);
      const score =
        judgeBlock.score !== undefined && judgeBlock.score !== null
          ? judgeBlock.score
          : payload.judge_score;
      if (verdictValid({ coarse_outcome: judgeBlock.coarse_outcome, score })) {
        embedded = {
          coarse: judgeBlock.coarse_outcome,
          score,
          feedback: typeof judgeBlock.feedback_md === 'string' ? judgeBlock.feedback_md : null,
        };
      }
    } else if (
      event.action === 'review' &&
      record.native_target.kind === 'submission_with_imported_eval' &&
      record.native_target.judge_event_id === null &&
      record.native_target.head_selection === 'sole_verdict'
    ) {
      const judgeBlock = payloadOf(payload.judge);
      if (verdictValid(judgeBlock)) {
        embedded = {
          coarse: judgeBlock.coarse_outcome,
          score: judgeBlock.score,
          feedback: typeof judgeBlock.feedback_md === 'string' ? judgeBlock.feedback_md : null,
        };
      }
    }
    if (embedded !== null) {
      candidates.push({
        evaluation_id: idOf('aev', `evaluation|${anchorId}|embedded`),
        run_refs: [anchorId],
        created_at: toDate(event.created_at, submittedAt),
        coarse_outcome: embedded.coarse,
        score: embedded.score,
        feedback_md: embedded.feedback,
        provenance_note: {
          embedded: true,
          anchor_event_id: anchorId,
          head_selection: 'sole_verdict',
        },
      });
    }
    candidates.sort((a, b) =>
      a.created_at.getTime() !== b.created_at.getTime()
        ? a.created_at.getTime() - b.created_at.getTime()
        : a.evaluation_id < b.evaluation_id
          ? -1
          : 1,
    );

    const pendingUnitDetail =
      'legacy 判词已导入为 provenance 证据；发布侧不存在获准的 legacy-verdict→points 映射，单元保持未决 —— 生效/换算属 settlement lane 在获准规则下的显式动作（重判是新判断，不是迁移）';
    const evaluations: EvaluationRowPlan[] = candidates.map((candidate) => ({
      evaluation_id: candidate.evaluation_id,
      evaluation_group_id: groupId,
      submission_id: submissionId,
      attempt: 0, // 占位 —— 下方按序赋值
      status: 'completed',
      unit_results: [
        {
          status: 'pending',
          scoring_unit_id: entry.scoring_unit_id,
          pending: { reason: 'needs_review', trigger: 'flagged', detail: pendingUnitDetail },
        },
      ],
      aggregate: { kind: 'unresolved', reason: 'pending_units', detail: pendingUnitDetail },
      plan_digest: null,
      run_refs: candidate.run_refs,
      provenance: {
        source: 'automatic',
        assisted: false,
        migrated: {
          tool: 'yuk1050-apply',
          algorithm_version: algorithmVersion,
          assisted: 'unknown' as const,
          legacy: { coarse_outcome: candidate.coarse_outcome, score: candidate.score },
          ...candidate.provenance_note,
        },
      },
      created_at: candidate.created_at,
    }));
    evaluations.forEach((e, index) => {
      e.attempt = index + 1;
    });

    // head：随 submission 建立，effective=NULL/generation=0 —— imported 判词
    // 不激活（§11/D4：activation 需 settlement 同事务生效；§13 non-effective
    // pending）。legacy effective truth 已入 mapping evidence。
    const chain: SubmissionChainPlan = {
      anchor_locator: record.source_locator,
      issuance: {
        issuance_id: issuanceId,
        revision_id: entry.revision_id,
        part_ids: issuance.part_ids,
        material_bindings: issuance.material_bindings,
        option_order: issuance.option_order,
        container_occurrence_ref: null,
        claim_policy: 'unbounded',
        claim_status: 'unclaimed',
        claimed_by_ref: null,
        issued_at: submittedAt,
      },
      group: {
        evaluation_group_id: groupId,
        submission_ids: [submissionId],
        created_at: submittedAt,
      },
      submission: {
        submission_id: submissionId,
        issuance_id: issuanceId,
        revision_id: entry.revision_id,
        evaluation_group_id: groupId,
        response_set: responseSet,
        group_evidence: [],
        idempotency_key: `legacy-${anchorId}`,
        submitted_at: submittedAt,
      },
      evaluations,
      head: {
        evaluation_group_id: groupId,
        submission_id: submissionId,
        effective_evaluation_id: null,
        generation: 0,
        updated_at: submittedAt,
      },
    };
    intent.submission = chain;

    if (intent.mapping !== null) {
      intent.mapping.evidence.response_digest = responseDigestOf(response);
      intent.mapping.evidence.preserved_attachments = attachments.map((a) => ({
        evidence_id: a.evidence_id,
        kind: a.kind,
        digest: a.asset.digest,
      }));
    }
  }

  // pass 3：judge/answer 镜像 —— 继承锚【最终】裁决（含忠实重建降级），锚
  // historical/conflicted/pending 时镜像不得独立拿到 target。
  for (const record of mirrorRecords) {
    buildRecordIntent(record);
  }

  // rollup（确定性顺序）。
  const ordered = [...intents].sort((a, b) =>
    a.classification.source_locator < b.classification.source_locator
      ? -1
      : a.classification.source_locator > b.classification.source_locator
        ? 1
        : 0,
  );
  const perCategory: Record<
    string,
    { records: number; mappings: number; submissions: number; evaluations: number }
  > = {};
  const totals = { records: 0, mappings: 0, submissions: 0, evaluations: 0 };
  for (const intent of ordered) {
    const category = intent.classification.category;
    let bucket = perCategory[category];
    if (bucket === undefined) {
      bucket = perCategory[category] = { records: 0, mappings: 0, submissions: 0, evaluations: 0 };
    }
    bucket.records += 1;
    totals.records += 1;
    if (intent.mapping !== null) {
      bucket.mappings += 1;
      totals.mappings += 1;
    }
    if (intent.submission !== null) {
      bucket.submissions += 1;
      totals.submissions += 1;
      bucket.evaluations += intent.submission.evaluations.length;
      totals.evaluations += intent.submission.evaluations.length;
    }
  }

  return {
    plan_version: 2,
    checkpoint_hash: input.checkpoint_hash,
    classification_version: input.classification.classification_version,
    classification_hash: input.classification.classification_hash,
    registry_digest: registryDigestOf(input.registry),
    algorithm_version: algorithmVersion,
    records: ordered,
    rollup: { per_category: perCategory, mapping_status: mappingStatusCount, totals },
    worklists: {
      unresolved: input.classification.unresolved,
      deferred_replay: input.classification.deferred_replay,
      awaiting_revision_registry: awaitingRegistry,
      conflicted,
      live_drafts: liveDrafts,
      reconstruction_blocked: reconstructionBlocked,
    },
  };
}

/** verdict 判别（迁移侧镜像：只做值域分支判定，不重新分类）。 */
function verdictValid(payload: { coarse_outcome?: unknown; score?: unknown }): boolean {
  const coarse = payload.coarse_outcome;
  const score = payload.score;
  const coarsePresent = coarse !== undefined && coarse !== null;
  const scorePresent = score !== undefined && score !== null;
  if (!coarsePresent && !scorePresent) return false;
  const branchOk = (expected: string, scoreCheck: (s: unknown) => boolean): boolean =>
    coarse === expected &&
    (score === undefined || score === null ? expected === 'unsupported' : scoreCheck(score));
  return (
    typeof coarse === 'string' &&
    (branchOk('correct', (s) => typeof s === 'number' && s >= 0.85 && s <= 1) ||
      branchOk('partial', (s) => typeof s === 'number' && s > 0 && s < 0.85) ||
      branchOk('incorrect', (s) => typeof s === 'number' && s === 0) ||
      branchOk('unsupported', () => false))
  );
}

function groupEntriesByQuestion(
  entries: RevisionRegistryEntry[],
): Map<string, RevisionRegistryEntry[]> {
  const map = new Map<string, RevisionRegistryEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.question_id) ?? [];
    list.push(entry);
    map.set(entry.question_id, list);
  }
  return map;
}

/** 目标 part 选择（P1-4）：answer.part_ref 优先且必须在该绑定的 part 集内；否则唯一 part；否则不猜。 */
function selectTargetPart(
  entry: RevisionRegistryEntry | null,
  partRef: string | null,
): string | null {
  if (entry === null) return null;
  if (partRef !== null && partRef.length > 0) {
    return entry.part_ids.includes(partRef) ? partRef : null;
  }
  const solePart = entry.part_ids.length === 1 ? entry.part_ids[0] : undefined;
  return solePart ?? null;
}
