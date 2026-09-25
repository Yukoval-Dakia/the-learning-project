import type {
  AggregateOutcomeT,
  GroupEvidenceT,
  IssuedMaterialBindingT,
  IssuedOptionOrderT,
  ResponseSetT,
  ScoringUnitResultT,
} from '../schema/assessment';
import { canonicalHash, shortHash } from './canonical';
import type {
  MigrationCapture,
  MigrationClassification,
  NativeCategory,
  RawAnswerRow,
  RawEventRow,
  RecordClassification,
} from './types';
import { verdictStatus } from './validation';

// ====================================================================
// YUK-1050 — 历史迁移 apply · 纯规划器（grounding §13、§15）
// ====================================================================
//
// 输入：YUK-1048 capture + classification（manifest 内持久化的完整分类输出）
//       + revision registry（语料导入 lane 的内容寻址工件，声明 legacy
//       question → 新 question_revision 的绑定）。
// 输出：MigrationApplyPlan —— 逐分类记录的确定性写意图（mapping /
//       issuance / group / submission / evaluation / effective head）。
//
// 本文件是【纯函数】：无 IO、无 DB、无 LLM。DB 执行器
// （src/server/migration/apply.ts）按 plan 幂等落库。
//
// 纪律（grounding §13，不可弱化）：
//   - 全量迁移 ≠ 批量历史重判：判词只从分类输出携带的 legacy verdict 迁移，
//     绝不重算、绝不补造（Completed 缺 DONE → reconstruct 不 regrade）。
//   - 无冻结上下文 ⇒ historical_unresolved；无 registry 绑定 ⇒ pending；
//     快照 digest 与 registry 声明不符 ⇒ conflicted。任何情况下都不拿
//     当前题面补造当时所见。
//   - 归因不是分数：attribution-only 记录只留证据，不产生 evaluation。
//   - 无学习重放：plan 不含任何 FSRS/θ̂/calibration 写意图。
//
// 与 YUK-1048 的接缝：分类记录是唯一语义真相 —— 规划器不重新分类、不重算
// 纠正闭包/head 选择；judge 记录的 has_effective_head / head_selection 直接
// 取自分类输出（anchor 记录与 judge 记录由分类器保证一致）。

export const APPLY_ALGORITHM_VERSION = 'yuk1050-apply/1.0.0';

/** 获得身份映射行的分类类别（lineage-only 类别不产生映射行）。 */
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

/** 产生 submission 链的分类类别（且仅当 revision 绑定已解析）。 */
const SUBMISSION_BEARING_CATEGORIES: ReadonlySet<NativeCategory> = new Set([
  'complete_attempt',
  'embedded_tutor_grade',
]);

// ───────────────────────── revision registry（接缝工件） ─────────────────────────

/**
 * 语料导入（publisher/normalizer lane 或隔离演练产物）声明的
 * legacy question → 新 revision 绑定。`snapshot_digest` 缺省 = 导入方断言
 * （无 digest 证明）；给出时必须与历史记录的冻结 snapshot digest 一致，
 * 否则该记录的映射落 conflicted（内容漂移，不得绑定）。
 */
export interface RevisionRegistryEntry {
  question_id: string;
  revision_id: string;
  /** issuance 绑定的 part 子集（导入方声明；solo 题 = 单 part）。 */
  part_ids: string[];
  slot_id: string | null;
  scoring_unit_id: string | null;
  snapshot_digest: string | null;
  published_at: string | null;
}

export interface RevisionRegistry {
  registry_version: 1;
  generated_by: string;
  entries: RevisionRegistryEntry[];
}

export interface RegistryParseIssue {
  detail: string;
}

/** 解析 + 校验 registry 工件（fail-visible：任何形状问题都拒绝，不猜）。 */
export function parseRevisionRegistry(
  input: unknown,
): { ok: true; registry: RevisionRegistry } | { ok: false; issues: RegistryParseIssue[] } {
  const issues: RegistryParseIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ detail: 'registry 根必须是对象' }] };
  }
  const root = input as Record<string, unknown>;
  if (root.registry_version !== 1) {
    issues.push({ detail: `registry_version 必须为 1（得到 ${String(root.registry_version)}）` });
  }
  if (typeof root.generated_by !== 'string' || root.generated_by.length === 0) {
    issues.push({ detail: 'generated_by 必须为非空字符串（工件来源可审计）' });
  }
  if (!Array.isArray(root.entries)) {
    issues.push({ detail: 'entries 必须为数组' });
    return { ok: false, issues };
  }
  const seenQuestion = new Set<string>();
  const seenRevision = new Set<string>();
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
    if (typeof questionId !== 'string' || questionId.length === 0) {
      issues.push({ detail: `entries[${idx}].question_id 必须为非空字符串` });
      continue;
    }
    if (seenQuestion.has(questionId)) {
      issues.push({ detail: `entries[${idx}].question_id='${questionId}' 重复 —— 一题一绑定` });
      continue;
    }
    if (typeof revisionId !== 'string' || revisionId.length === 0) {
      issues.push({ detail: `entries[${idx}].revision_id 必须为非空字符串` });
      continue;
    }
    if (seenRevision.has(revisionId)) {
      issues.push({
        detail: `entries[${idx}].revision_id='${revisionId}' 重复 —— 一 revision 一绑定`,
      });
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
    seenQuestion.add(questionId);
    seenRevision.add(revisionId);
    entries.push({
      question_id: questionId,
      revision_id: revisionId,
      part_ids: partIds as string[],
      slot_id: typeof entry.slot_id === 'string' && entry.slot_id.length > 0 ? entry.slot_id : null,
      scoring_unit_id:
        typeof entry.scoring_unit_id === 'string' && entry.scoring_unit_id.length > 0
          ? entry.scoring_unit_id
          : null,
      snapshot_digest:
        typeof entry.snapshot_digest === 'string' && entry.snapshot_digest.length > 0
          ? entry.snapshot_digest
          : null,
      published_at:
        typeof entry.published_at === 'string' && entry.published_at.length > 0
          ? entry.published_at
          : null,
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    registry: { registry_version: 1, generated_by: root.generated_by as string, entries },
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
  effective_evaluation_id: string | null;
  generation: number;
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
  /** anchor 记录且 revision 已解析时携带 submission 链。 */
  submission: SubmissionChainPlan | null;
}

export interface AwaitingRegistryEntry {
  source_locator: string;
  original_question_id: string;
  category: NativeCategory;
}

export interface ConflictedEntry {
  source_locator: string;
  original_question_id: string;
  reason: string;
}

export interface MigrationApplyPlan {
  plan_version: 1;
  checkpoint_hash: string;
  classification_version: string;
  classification_hash: string;
  registry_digest: string | null;
  algorithm_version: string;
  records: ApplyRecordIntent[];
  /** 每 category：记录数 / 映射行 / submission 链 / evaluation / head。 */
  rollup: {
    per_category: Record<
      string,
      { records: number; mappings: number; submissions: number; evaluations: number }
    >;
    mapping_status: Record<MappingStatus, number>;
    totals: { records: number; mappings: number; submissions: number; evaluations: number };
  };
  worklists: {
    unresolved: MigrationClassification['unresolved'];
    deferred_replay: MigrationClassification['deferred_replay'];
    awaiting_revision_registry: AwaitingRegistryEntry[];
    conflicted: ConflictedEntry[];
  };
}

export function planDigestOf(plan: MigrationApplyPlan): string {
  return canonicalHash({
    plan_version: plan.plan_version,
    checkpoint_hash: plan.checkpoint_hash,
    classification_hash: plan.classification_hash,
    registry_digest: plan.registry_digest,
    algorithm_version: plan.algorithm_version,
    records: plan.records.map((r) => ({
      locator: r.classification.source_locator,
      mapping:
        r.mapping === null
          ? null
          : {
              id: r.mapping.mapping_id,
              status: r.mapping.status,
              target: r.mapping.target_revision_id,
            },
      submission:
        r.submission === null
          ? null
          : {
              submission_id: r.submission.submission.submission_id,
              evaluations: r.submission.evaluations.map((e) => e.evaluation_id),
            },
    })),
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

/** 冻结作答响应的 digest（pending 保留 response digest，§13）。 */
export function responseDigestOf(input: {
  response_md: string | null;
  image_refs: string[];
}): string {
  return canonicalHash({
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

/** legacy 作答文本 + 图片 refs（attempt / review / durable pending submit）。 */
function legacyResponseOf(
  record: RecordClassification,
  eventById: Map<string, RawEventRow>,
  pendingByRunId: Map<string, RawEventRow>,
): { response_md: string | null; image_refs: string[]; submitted_at: string | null } {
  if (record.source_kind !== 'event')
    return { response_md: null, image_refs: [], submitted_at: null };
  const event = eventById.get(record.source_id);
  if (event === undefined) return { response_md: null, image_refs: [], submitted_at: null };
  const payload = payloadOf(event.payload);
  const imageRefs = Array.isArray(payload.answer_image_refs)
    ? (payload.answer_image_refs as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (event.action === 'attempt') {
    return {
      response_md: typeof payload.answer_md === 'string' ? payload.answer_md : null,
      image_refs: imageRefs,
      submitted_at: event.created_at,
    };
  }
  if (event.action === 'review') {
    // durable 回填：提交时刻以 pending submit 冻结的 submitted_at 为准。
    const pending = pendingByRunId.get(event.id);
    const submit = pending === undefined ? {} : payloadOf(payloadOf(pending.payload).submit);
    const submitAt = typeof submit.submitted_at === 'string' ? submit.submitted_at : null;
    return {
      response_md: typeof payload.user_response_md === 'string' ? payload.user_response_md : null,
      image_refs: imageRefs,
      submitted_at: submitAt ?? event.created_at,
    };
  }
  if (event.action === 'experimental:judge_pending_attempt') {
    // 冻结输入本体（run/request/pending 身份的响应零丢失，§13）。
    const submit = payloadOf(payload.submit);
    const body = payloadOf(submit.body);
    return {
      response_md: typeof body.response_md === 'string' ? body.response_md : null,
      image_refs: imageRefs,
      submitted_at:
        typeof submit.submitted_at === 'string' ? submit.submitted_at : event.created_at,
    };
  }
  return { response_md: null, image_refs: [], submitted_at: null };
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
  algorithm_version?: string;
}

/**
 * 分类输出 → 确定性写意图。同输入 ⇒ 同 plan（同 id、同 digest、同行内容）
 * —— 这是 apply 幂等与 crash 续跑的基础：一切主键都是内容寻址派生，
 * 重放不产生新行。
 */
export function buildMigrationApplyPlan(input: BuildApplyPlanInput): MigrationApplyPlan {
  const algorithmVersion = input.algorithm_version ?? APPLY_ALGORITHM_VERSION;
  const eventById = new Map(input.capture.rawFacts.events.map((e) => [e.id, e] as const));
  const answerById = new Map(input.capture.rawFacts.answers.map((a) => [a.id, a]));
  const registryByQuestion =
    input.registry === null
      ? new Map<string, RevisionRegistryEntry>()
      : new Map(input.registry.entries.map((e) => [e.question_id, e] as const));
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
  const mappingStatusCount: Record<MappingStatus, number> = {
    pending: 0,
    mapped: 0,
    conflicted: 0,
    historical_unresolved: 0,
  };

  // 阶段 1：逐记录解析身份 → 映射行意图。
  // anchorSubmissionByLocator 由阶段 2 填充（anchor 先于 judge 聚合处理）。
  const resolutionByLocator = new Map<
    string,
    { status: MappingStatus; entry: RevisionRegistryEntry | null; reason: string }
  >();

  for (const record of input.classification.records) {
    if (!MAPPING_BEARING_CATEGORIES.has(record.category)) {
      intents.push({ classification: record, mapping: null, submission: null });
      continue;
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

    let status: MappingStatus;
    let entry: RevisionRegistryEntry | null = null;
    let resolutionReason: string;
    // judge / answer 镜像记录继承其锚 occurrence 的裁决（分类器已保证锚与
    // 镜像判定一致）：锚因快照漂移 conflicted / 缺件 pending 时，镜像不得
    // 独立绕过锚而拿到 target —— 一次 occurrence 一个身份裁决。
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
    if (anchorResolution !== undefined) {
      status = anchorResolution.status;
      entry = anchorResolution.entry;
      resolutionReason = `继承锚 occurrence（${resolutionAnchor !== null ? resolutionAnchor.id : ''}）的裁决：${anchorResolution.reason}`;
      // worklist（awaiting/conflicted）以锚记录为代表 —— 镜像行不重复登记。
    } else if (record.category === 'historical_unresolved') {
      status = 'historical_unresolved';
      resolutionReason = '缺冻结上下文 —— 身份不可解析（§13：不得用当前题面补造当时所见）';
    } else if (record.category === 'correction_cycle_unresolved') {
      status = 'conflicted';
      resolutionReason = '纠正链闭包成员 —— 多个竞争 effective-truth，保持 conflicted/unresolved';
    } else {
      const candidate = registryByQuestion.get(originalQuestionId) ?? null;
      if (candidate === null) {
        status = 'pending';
        resolutionReason = 'revision registry 无该题绑定 —— 身份待语料导入后解析';
        awaitingRegistry.push({
          source_locator: record.source_locator,
          original_question_id: originalQuestionId,
          category: record.category,
        });
      } else if (
        snapshotDigest !== null &&
        candidate.snapshot_digest !== null &&
        candidate.snapshot_digest !== snapshotDigest
      ) {
        status = 'conflicted';
        resolutionReason = `冻结 snapshot digest 与 registry 声明不符（记录 ${snapshotDigest.slice(0, 12)} vs registry ${candidate.snapshot_digest.slice(0, 12)}）—— 内容漂移，不得绑定`;
        conflicted.push({
          source_locator: record.source_locator,
          original_question_id: originalQuestionId,
          reason: resolutionReason,
        });
      } else {
        status = 'mapped';
        entry = candidate;
        resolutionReason =
          snapshotDigest !== null && candidate.snapshot_digest !== null
            ? '冻结 snapshot digest 与 registry 声明一致 —— 绑定已验证'
            : 'registry 断言绑定（无 digest 对照可用）';
      }
    }
    resolutionByLocator.set(record.source_locator, { status, entry, reason: resolutionReason });
    mappingStatusCount[status] += 1;

    const evidence: Record<string, unknown> = {
      category: record.category,
      reason: record.reason,
      evidence_event_ids: record.evidence_event_ids,
      native_target: record.native_target,
      resolution: {
        status,
        reason: resolutionReason,
        registry_snapshot_binding:
          snapshotDigest !== null && entry?.snapshot_digest === snapshotDigest
            ? 'digest_verified'
            : entry != null
              ? 'registry_assertion'
              : null,
      },
      migration: {
        tool: 'yuk1050-apply',
        algorithm_version: algorithmVersion,
        classification_version: input.classification.classification_version,
      },
    };
    if (snapshotDigest !== null) evidence.snapshot_digest = snapshotDigest;
    if (record.category === 'pending_blocked' && record.native_target.kind === 'pending_carried') {
      evidence.pending = record.native_target.pending;
      const response = legacyResponseOf(record, eventById, pendingByRunId);
      evidence.response_digest = responseDigestOf(response);
      evidence.image_asset_refs = response.image_refs;
      const event = record.source_kind === 'event' ? eventById.get(record.source_id) : undefined;
      const runId = event !== undefined ? payloadOf(event.payload).run_id : undefined;
      if (typeof runId === 'string') evidence.run_id = runId;
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
    if (record.category.startsWith('attribution')) {
      evidence.attribution_only = true;
    }
    if (record.native_target.kind === 'submission_with_imported_eval') {
      evidence.head_selection = record.native_target.head_selection;
      evidence.judge_event_id = record.native_target.judge_event_id;
      evidence.has_effective_head = record.native_target.has_effective_head;
    }

    intents.push({
      classification: record,
      mapping: {
        mapping_id: idOf('amp', record.source_kind, record.source_id, record.source_locator),
        source_kind: record.source_kind,
        source_id: record.source_id,
        source_locator: record.source_locator,
        original_question_id: originalQuestionId,
        legacy_part_ref: answerRow?.part_ref ?? null,
        snapshot_digest: snapshotDigest,
        target_revision_id: status === 'mapped' ? (entry?.revision_id ?? null) : null,
        target_part_id: status === 'mapped' ? (entry?.part_ids[0] ?? null) : null,
        target_slot_id: status === 'mapped' ? (entry?.slot_id ?? null) : null,
        evidence,
        algorithm_version: algorithmVersion,
        status,
        created_at: createdAt,
      },
      submission: null,
    });
  }

  // 阶段 2：anchor 记录（complete_attempt / embedded_tutor_grade 且映射 mapped）
  // → submission 链；judge 记录的 evaluation 挂到锚的 submission。
  const submissionByAnchorLocator = new Map<string, SubmissionChainPlan>();
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

    const anchorId = record.source_id;
    const entry = resolution.entry;
    const groupId = idOf('aeg', `group|${anchorId}`);
    const submissionId = idOf('asb', `submission|${anchorId}`);
    const issuanceId = idOf('ais', `issuance|${anchorId}|${entry.revision_id}`);

    const response = legacyResponseOf(record, eventById, pendingByRunId);
    const submittedAt = toDate(response.submitted_at, fallbackTime);

    // evaluation 候选：配对 verdict judge（分类输出，含 head 与非 head）+ 嵌入判词。
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
      const payload = payloadOf(judgeEvent.payload);
      if (verdictStatus(payload) !== 'valid') continue;
      candidates.push({
        evaluation_id: idOf('aev', `evaluation|${anchorId}|${judgeRecord.source_id}`),
        run_refs: [judgeRecord.source_id],
        created_at: toDate(judgeEvent.created_at, submittedAt),
        coarse_outcome: payload.coarse_outcome,
        score: payload.score,
        feedback_md: typeof payload.feedback_md === 'string' ? payload.feedback_md : null,
        provenance_note: {
          judge_event_id: judgeRecord.source_id,
          head_selection: judgeRecord.native_target.head_selection,
          is_effective_head: judgeRecord.native_target.has_effective_head,
        },
      });
    }
    // 嵌入判词：solve_tutor attempt 或 durable review 的 embedded judge 块。
    const payload = payloadOf(event.payload);
    let embedded: { coarse: unknown; score: unknown; feedback: string | null } | null = null;
    if (event.action === 'attempt' && payload.source === 'solve_tutor') {
      const judgeBlock = payloadOf(payload.judge);
      const score = judgeBlock.score ?? payload.judge_score;
      if (verdictStatus({ coarse_outcome: judgeBlock.coarse_outcome, score }) === 'valid') {
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
      if (verdictStatus(judgeBlock) === 'valid') {
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
    // 确定性 attempt 序：created_at，并列时 id（分类器已保证 head 唯一，这里只定序）。
    candidates.sort((a, b) =>
      a.created_at.getTime() !== b.created_at.getTime()
        ? a.created_at.getTime() - b.created_at.getTime()
        : a.evaluation_id < b.evaluation_id
          ? -1
          : 1,
    );

    const evaluations: EvaluationRowPlan[] = candidates.map((candidate, index) => ({
      evaluation_id: candidate.evaluation_id,
      evaluation_group_id: groupId,
      submission_id: submissionId,
      attempt: index + 1,
      status: 'completed',
      unit_results:
        entry.scoring_unit_id !== null
          ? [
              {
                status: 'scored',
                scoring_unit_id: entry.scoring_unit_id,
                points_awarded: null,
                scored_because: 'response',
                ...(candidate.feedback_md !== null ? { feedback_md: candidate.feedback_md } : {}),
                evidence_citations: [],
              },
            ]
          : [],
      aggregate: {
        kind: 'unresolved',
        reason: 'no_mapping',
        detail: 'imported legacy verdict — 迁移导入判词，无发布侧 unit points 映射，不制造总分',
      },
      plan_digest: null,
      run_refs: candidate.run_refs,
      provenance: {
        source: 'automatic',
        assisted: false,
        migrated: {
          tool: 'yuk1050-apply',
          algorithm_version: algorithmVersion,
          legacy: { coarse_outcome: candidate.coarse_outcome, score: candidate.score },
          ...candidate.provenance_note,
        },
      },
      created_at: candidate.created_at,
    }));

    // effective head：分类器的 anchor 判定 —— imported 锚看 has_effective_head，
    // embedded 锦标（solve_tutor）本身即唯一 verdict，直接生效。
    let headEvaluationId: string | null = null;
    if (
      record.native_target.kind === 'submission_with_imported_eval' &&
      record.native_target.has_effective_head
    ) {
      const headJudgeId = record.native_target.judge_event_id;
      headEvaluationId =
        headJudgeId !== null
          ? idOf('aev', `evaluation|${anchorId}|${headJudgeId}`)
          : idOf('aev', `evaluation|${anchorId}|embedded`);
    } else if (record.native_target.kind === 'submission_with_embedded_eval') {
      headEvaluationId = idOf('aev', `evaluation|${anchorId}|embedded`);
    }
    const headTime =
      evaluations.find((e) => e.evaluation_id === headEvaluationId)?.created_at ?? submittedAt;

    const chain: SubmissionChainPlan = {
      anchor_locator: record.source_locator,
      issuance: {
        issuance_id: issuanceId,
        revision_id: entry.revision_id,
        part_ids: [...entry.part_ids],
        material_bindings: [],
        option_order: [],
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
        response_set: {
          entries: [
            {
              slot_id: entry.slot_id ?? 'legacy-open-response',
              kind: 'open',
              text_md: response.response_md ?? '',
              evidence: [],
            },
          ],
        },
        group_evidence: [],
        idempotency_key: `legacy-${anchorId}`,
        submitted_at: submittedAt,
      },
      evaluations,
      head: {
        evaluation_group_id: groupId,
        submission_id: submissionId,
        effective_evaluation_id: headEvaluationId,
        generation: headEvaluationId !== null ? 1 : 0,
        updated_at: headTime,
      },
    };
    submissionByAnchorLocator.set(record.source_locator, chain);
    intent.submission = chain;

    // 响应 digest 进映射证据（D5 零丢失对账锚）。
    if (intent.mapping !== null) {
      intent.mapping.evidence.response_digest = responseDigestOf(response);
      intent.mapping.evidence.image_asset_refs = response.image_refs;
    }
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
    plan_version: 1,
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
    },
  };
}
