import { z } from 'zod';
import { extractAnswerHead } from '../judge-routing';
import { type ExecutorDescriptorT, type ModelExecutorT, validateExecutionPlan } from './execution';
import {
  type AggregateOutcomeT,
  EvaluationRecord,
  type EvaluationRecordT,
  type EvidenceCitationT,
  type GroupEvidenceT,
  ScoringUnitResult,
  type ScoringUnitResultT,
  type SubmissionRecordT,
  aggregateUnitResults,
} from './judgment';
import type { SharedMaterialT } from './materials';
import { PendingState, type PendingStateT } from './pending';
import type { ResponseSlotT, ResponseSpecT, SlotResponseT } from './response';
import { isBlankSlotResponse, validateResponseSet } from './response';
import type { PublishedQuestionRevisionT } from './revision';
import { type ScoringBasisT, type ScoringUnitT, validateScoringBasis } from './scoring';

// ====================================================================
// YUK-1047 — 判分执行器统一 · 确定性评估引擎（grounding §4.2–§4.4、D4/D13–D17）
// ====================================================================
//
// 本模块是 evaluateSubmission 的【纯确定性内核】：无 IO、无 DB、无 LLM。
// 输入是冻结契约（submission + published revision + issuance scope），输出是
// candidate EvaluationRecord —— 【绝不】触碰 effective head（activation 归
// YUK-1045），也【绝不】写学习状态（settlement 归 YUK-1053）。
//
// 计分纪律（§4.4，不可弱化）：
//   - scoring unit 是唯一计分权威；每个 unit 恰好被一个 executor 判一次；
//   - 比较器只做确定性判定 —— 全对 = 发布 points，否则 0；部分分不属于
//     比较器职责（固定梯度数值政策已降级为历史，不做新题默认）；
//   - 空白 ≠ missing ≠ unparseable ≠ insufficient ≠ infra_failure ≠
//     needs_review —— 六类未决分别表达；只有完整提交且 blank_scores_zero
//     政策明确时主动空白才计 0（scored_because='blank_marked_zero'）；
//   - 模型置信度/概率与学生分数彻底分离；holistic 未映射不凭空造总分；
//   - model_executor 必须携带 D17 已准入切片，否则按 escalation 未决，
//     绝不悄悄执行；执行器端口是注入 seam —— 本文件没有任何 provider 调用。
//
// 候选语义：评估结果只是 candidate，activation（CAS + admission generation
// 复核 + 学习结算事务）由 YUK-1045/1053 接管。candidate 永不进显示通道。

// ---------- 评估 provenance（D9/D15/D16） ----------

export const EvaluationProvenance = z.object({
  source: z.enum(['automatic', 'manual', 'self_report']),
  assisted: z.boolean().default(false),
});
export type EvaluationProvenanceT = z.infer<typeof EvaluationProvenance>;

// ---------- 执行期 policy（不改给分规则，只控执行面） ----------

export const EvaluationExecutionPolicy = z.object({
  /**
   * 模型输出的低置信阈值：outcome.confidence < threshold 时按
   * plan.escalation.on_low_confidence 处理。confidence 是分布形状度量，
   * 不是 accuracy（D17/OpenRouter 核验）—— 缺省=不启用该 gate。
   */
  low_confidence_threshold: z.number().min(0).max(1).optional(),
});
export type EvaluationExecutionPolicyT = z.infer<typeof EvaluationExecutionPolicy>;

// ---------- 模型执行器端口（无 LLM；调用方注入实现） ----------

/**
 * 模型单元裁决。`scored` 只报告判据层面的【规则/档位命中】与发布口径分数
 * （additive 单元必须给 points_awarded；holistic 单元必须给 matched.level_id
 * 而 points_awarded=null —— 模型不得在输出里自造等级分数，§4.4/judgment.ts）。
 * `pending` 承载显式未决态（含 infra_failure.retryable）。
 */
export const ModelUnitOutcome = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scored'),
    points_awarded: z.number().min(0).nullable(),
    matched: z
      .object({
        rule_id: z.string().min(1).optional(),
        level_id: z.string().min(1).optional(),
        option_ids: z.array(z.string().min(1)).default([]),
      })
      .optional(),
    feedback_md: z.string().optional(),
    evidence_citations: z
      .array(
        z.object({
          slot_id: z.string().min(1).optional(),
          evidence_id: z.string().min(1).optional(),
          quote: z.string().optional(),
        }),
      )
      .default([]),
    /** 分布形状信号（非 accuracy）；缺失不得补造（OpenRouter 核验 D12）。 */
    confidence: z.number().min(0).max(1).optional(),
    run_refs: z.array(z.string().min(1)).default([]),
    cost_usd_micros: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('pending'),
    pending: PendingState,
    confidence: z.number().min(0).max(1).optional(),
    run_refs: z.array(z.string().min(1)).default([]),
    cost_usd_micros: z.number().int().min(0).optional(),
  }),
]);
export type ModelUnitOutcomeT = z.infer<typeof ModelUnitOutcome>;

/** 单次模型单元判定的冻结输入（执行器只见它需要的槽位/证据/材料）。 */
export interface ModelExecutorRequest {
  submission_id: string;
  evaluation_group_id: string;
  revision_id: string;
  attempt: number;
  scoring_unit_id: string;
  executor: ModelExecutorT;
  /** 该 unit 声明读取的槽位响应（已按 spec 校验过）。 */
  slot_responses: SlotResponseT[];
  /** 该 unit 命中的 group 级证据（all_units 或显式子集）。 */
  group_evidence: GroupEvidenceT[];
  /** 该 unit 声明的共享材料（判分与学生所见同版资产）。 */
  materials: SharedMaterialT[];
  /** 本计划累计已花成本（micro USD）—— 端口可据此自重预算。 */
  spent_cost_usd_micros: number;
}

/**
 * 模型执行器端口：把 admitted model_executor 的判定委托给注入实现。
 * 本模块【不】提供实现 —— typed transport（OpenRouter/Jev 或既有 runner）
 * 归 AI 层 lane 接线；本内核只定义契约、校验输出并执行 escalation。
 */
export type ModelUnitExecutorPort = (request: ModelExecutorRequest) => Promise<ModelUnitOutcomeT>;

// ---------- 评估输入 ----------

export interface EvaluateSubmissionCoreInput {
  /** 预铸 evaluation 身份（调用方负责唯一性/可重试性）。 */
  evaluation_id: string;
  /** 冻结作答（D5：原文不改写）。 */
  submission: SubmissionRecordT;
  /** 不可变发布 revision（submission.revision_id 指向）。 */
  revision: PublishedQuestionRevisionT;
  /**
   * 本次 issuance 实际发出的 part 子集（null/省略 = 全组）。
   * 只有【全部作答面都落在发出范围内】的 unit 才进入本次评估；
   * 引用未发出槽位的 unit 视为属于另一 issuance，不评、不 pending。
   */
  issued_part_ids?: readonly string[];
  /** 第几次评估尝试（≥1）；重试身份 ≠ 学习事实身份。 */
  attempt: number;
  /** 判分来源；缺省 {source:'automatic',assisted:false}（schema 语义）。 */
  provenance?: EvaluationProvenanceT;
  /**
   * 执行期 plan digest（canonical hash of {execution_plan, scoring_basis}，
   * 由持久化层计算 —— 本模块不引 node:crypto 保持纯前端可打包）。
   */
  plan_digest?: string | null;
  policy?: EvaluationExecutionPolicyT;
  /**
   * manual_assert：D9 显式手动/自评 —— 直接携带已判 unit 结果
   * （asserted_unit_results），跳过执行器分发；provenance.source 必须
   * 为 manual|self_report。execute：按 execution_plan 分发。
   */
  mode?: 'execute' | 'manual_assert';
  asserted_unit_results?: readonly ScoringUnitResultT[];
  /** model_executor 的注入实现；admitted executor 存在且未注入 ⇒ 单元 infra_failure。 */
  model_executor?: ModelUnitExecutorPort;
}

export interface EvaluateSubmissionCoreOutput {
  record: EvaluationRecordT;
  /** 本次实际调用了模型执行器的单元数（观测/成本审计）。 */
  model_units_invoked: number;
  /** 本次模型调用累计成本（micro USD；仅端口如实上报的合计）。 */
  spent_cost_usd_micros: number;
}

export class EvaluationContractError extends Error {
  override name = 'EvaluationContractError';
  constructor(
    public readonly code:
      | 'submission_revision_mismatch'
      | 'invalid_response_set'
      | 'invalid_scoring_basis'
      | 'invalid_execution_plan'
      | 'unprojectable_aggregation'
      | 'manual_mode_requires_manual_provenance'
      | 'manual_mode_requires_asserted_results'
      | 'manual_result_set_mismatch',
    detail: string,
  ) {
    super(`evaluateSubmission: ${code} — ${detail}`);
  }
}

// ---------- 内部工具 ----------

const pending = (state: PendingStateT): ScoringUnitResultT => ({
  status: 'pending',
  scoring_unit_id: '',
  pending: state,
});

const withUnit = (result: ScoringUnitResultT, unitId: string): ScoringUnitResultT => ({
  ...result,
  scoring_unit_id: unitId,
});

/** 发出的 part 范围内的作答槽位集合（table 布局容器不直接作答）。 */
function answerableSlots(spec: ResponseSpecT, issuedParts: ReadonlySet<string>): ResponseSlotT[] {
  return spec.slots.filter((slot) => issuedParts.has(slot.part_id) && slot.kind !== 'table');
}

/** unit 的全部作答槽（slot_refs ∪ evidence_slot_refs）是否都在发出范围内。 */
function unitInScope(unit: ScoringUnitT, slotById: Map<string, ResponseSlotT>): boolean {
  return [...unit.slot_refs, ...unit.evidence_slot_refs].every(
    (slotId) => slotById.get(slotId) != null,
  );
}

/** 归一化文本（text_key.normalization 四档）。 */
function normalizeText(
  value: string,
  mode: 'exact' | 'trim' | 'trim_casefold_nfc' | 'answer_head',
): string {
  switch (mode) {
    case 'exact':
      return value;
    case 'trim':
      return value.trim();
    case 'trim_casefold_nfc':
      return value.normalize('NFKC').trim().toLowerCase();
    case 'answer_head':
      // 与 legacy exact 判分同语义：先抽答案头（"答：B"→"B"、答案+解析→答案），
      // 再 NFKC + trim + lowercase。
      return extractAnswerHead(value).normalize('NFKC').trim().toLowerCase();
  }
}

/**
 * numeric 槽的单位截取：剥掉头部数值 token 后剩余的非空后缀视为单位候选。
 * 确定性、零猜测 —— 复合表达式不解析，解析不出单位即不匹配。
 */
function extractUnitSuffix(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  const match = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?\s*(.*)$/u.exec(trimmed);
  if (match == null) return null;
  const suffix = match[1].trim();
  return suffix.length > 0 ? suffix : null;
}

/** 确定性比较器：单槽命中判定（全对=发布 points，否则 0；无部分分）。
 * 判据/槽位不配对是契约违背 —— 返回 pending unjudgeable，绝不落伪零分。 */
function runDeterministicComparator(
  comparator: 'exact_option_set' | 'exact_text' | 'numeric_tolerance' | 'exact_matching_pairs',
  unit: ScoringUnitT,
  entry: SlotResponseT,
): ScoringUnitResultT {
  const full = unit.points ?? 0;
  switch (comparator) {
    case 'exact_option_set': {
      if (entry.kind !== 'choice' || unit.criterion.kind !== 'option_set_key') {
        return unjudgeableMismatch(unit, 'slot/entry kind mismatch for option_set_key');
      }
      const accepted = new Set(unit.criterion.accepted_option_ids);
      const given = new Set(entry.option_ids);
      const hit = accepted.size === given.size && [...given].every((id) => accepted.has(id));
      return {
        status: 'scored',
        scoring_unit_id: unit.scoring_unit_id,
        points_awarded: hit ? full : 0,
        scored_because: 'response',
        matched: { option_ids: entry.option_ids },
        evidence_citations: [{ slot_id: entry.slot_id }],
      };
    }
    case 'exact_text': {
      // text_key 可落在 text 或 open_response 槽（后者文本在 entry.text_md）。
      const textValue = entry.kind === 'text' || entry.kind === 'open' ? entry.text_md : null;
      if (textValue == null || unit.criterion.kind !== 'text_key') {
        return unjudgeableMismatch(unit, 'slot/entry kind mismatch for text_key');
      }
      const given = normalizeText(textValue, unit.criterion.normalization);
      const hit = unit.criterion.accepted_texts.some(
        (accepted) =>
          normalizeText(
            accepted,
            unit.criterion.kind === 'text_key' ? unit.criterion.normalization : 'trim',
          ) === given,
      );
      return {
        status: 'scored',
        scoring_unit_id: unit.scoring_unit_id,
        points_awarded: hit ? full : 0,
        scored_because: 'response',
        evidence_citations: [{ slot_id: entry.slot_id }],
      };
    }
    case 'numeric_tolerance': {
      if (entry.kind !== 'numeric' || unit.criterion.kind !== 'numeric_key') {
        return unjudgeableMismatch(unit, 'slot/entry kind mismatch for numeric_key');
      }
      const value = entry.value ?? Number.NaN;
      const { expected, tolerance, expected_unit } = unit.criterion;
      const diff = Math.abs(value - expected);
      const inTolerance =
        Number.isFinite(value) &&
        (tolerance.kind === 'absolute'
          ? diff <= tolerance.value
          : expected === 0
            ? diff === 0
            : diff / Math.abs(expected) <= tolerance.ratio);
      if (!inTolerance) {
        return {
          status: 'scored',
          scoring_unit_id: unit.scoring_unit_id,
          points_awarded: 0,
          scored_because: 'response',
          evidence_citations: [{ slot_id: entry.slot_id }],
        };
      }
      if (expected_unit != null) {
        const suffix = entry.raw_input == null ? null : extractUnitSuffix(entry.raw_input);
        if (suffix == null || suffix.normalize('NFKC') !== expected_unit.normalize('NFKC')) {
          return {
            status: 'scored',
            scoring_unit_id: unit.scoring_unit_id,
            points_awarded: 0,
            scored_because: 'response',
            feedback_md: 'unit_mismatch',
            evidence_citations: [{ slot_id: entry.slot_id }],
          };
        }
      }
      return {
        status: 'scored',
        scoring_unit_id: unit.scoring_unit_id,
        points_awarded: full,
        scored_because: 'response',
        evidence_citations: [{ slot_id: entry.slot_id }],
      };
    }
    case 'exact_matching_pairs': {
      if (entry.kind !== 'matching' || unit.criterion.kind !== 'matching_pairs_key') {
        return unjudgeableMismatch(unit, 'slot/entry kind mismatch for matching_pairs_key');
      }
      const accepted = new Map(
        unit.criterion.accepted_pairs.map((pair) => [pair.item_id, pair.option_id] as const),
      );
      const hit =
        entry.pairs.length === accepted.size &&
        entry.pairs.every((pair) => accepted.get(pair.item_id) === pair.option_id);
      return {
        status: 'scored',
        scoring_unit_id: unit.scoring_unit_id,
        points_awarded: hit ? full : 0,
        scored_because: 'response',
        evidence_citations: [{ slot_id: entry.slot_id }],
      };
    }
  }
}

function unjudgeableMismatch(unit: ScoringUnitT, detail: string): ScoringUnitResultT {
  return {
    status: 'pending',
    scoring_unit_id: unit.scoring_unit_id,
    pending: {
      reason: 'unjudgeable',
      detail: `deterministic comparator could not apply: ${detail}`,
    },
  };
}

/** 模型引用证据的完整性校验：cited evidence_id 必须真实存在于本提交内（D17 严重错误防线）。 */
function collectKnownEvidenceIds(
  submission: SubmissionRecordT,
  slotResponses: readonly SlotResponseT[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of slotResponses) {
    if (entry.kind === 'open') {
      for (const evidence of entry.evidence) ids.add(evidence.evidence_id);
    }
  }
  for (const groupEvidence of submission.group_evidence) {
    ids.add(groupEvidence.evidence.evidence_id);
  }
  return ids;
}

function citationsResolve(
  citations: readonly EvidenceCitationT[],
  slotIds: Set<string>,
  evidenceIds: Set<string>,
): string | null {
  for (const citation of citations) {
    if (citation.slot_id != null && !slotIds.has(citation.slot_id)) {
      return `cited unknown slot '${citation.slot_id}'`;
    }
    if (citation.evidence_id != null && !evidenceIds.has(citation.evidence_id)) {
      return `cited unknown evidence '${citation.evidence_id}'`;
    }
  }
  return null;
}

// ---------- 主流程 ----------

/**
 * evaluateSubmission 的纯内核：submission + frozen revision → candidate
 * EvaluationRecord。所有未决分支显式建模，绝不产出伪零分。
 */
export async function evaluateSubmissionCore(
  input: EvaluateSubmissionCoreInput,
): Promise<EvaluateSubmissionCoreOutput> {
  const { submission, revision } = input;
  if (submission.revision_id !== revision.revision_id) {
    throw new EvaluationContractError(
      'submission_revision_mismatch',
      `submission '${submission.submission_id}' pins revision '${submission.revision_id}' but was evaluated against '${revision.revision_id}'`,
    );
  }

  const provenance = input.provenance ?? { source: 'automatic' as const, assisted: false };
  const mode = input.mode ?? 'execute';
  if (mode === 'manual_assert') {
    if (provenance.source === 'automatic') {
      throw new EvaluationContractError(
        'manual_mode_requires_manual_provenance',
        'manual_assert requires provenance.source manual|self_report',
      );
    }
    if (input.asserted_unit_results == null) {
      throw new EvaluationContractError(
        'manual_mode_requires_asserted_results',
        'manual_assert requires asserted_unit_results',
      );
    }
  }

  const spec = revision.response_spec;
  const basis = revision.scoring_basis;
  const plan = revision.execution_plan;

  // ---- 结构一致性：冻结响应集合对发出 spec 的静态校验（错 ⇒ 拒绝评估，不逐单元猜）。----
  const setIssues = validateResponseSet(spec, submission.response_set);
  if (setIssues.length > 0) {
    throw new EvaluationContractError(
      'invalid_response_set',
      setIssues.map((issue) => `${issue.code}(${issue.detail})`).join('; '),
    );
  }
  const basisIssues = validateScoringBasis(basis, spec, revision.structure);
  if (basisIssues.length > 0) {
    throw new EvaluationContractError(
      'invalid_scoring_basis',
      basisIssues.map((issue) => `${issue.code}(${issue.detail})`).join('; '),
    );
  }
  // unadmitted_model_executor 是发布期问题（publisher/migration 用它拒绝
  // 发布）；评估期它不是结构违背 —— 准入缺失由 plan.escalation 转成
  // 显式 pending（withhold → unjudgeable / human_review → needs_review），
  // 绝不让评估因「未准入」整体失败（否则冻结历史提交永远不可评估）。
  const planIssues = validateExecutionPlan(plan, basis).filter(
    (issue) => issue.code !== 'unadmitted_model_executor',
  );
  if (planIssues.length > 0) {
    throw new EvaluationContractError(
      'invalid_execution_plan',
      planIssues.map((issue) => `${issue.code}(${issue.detail})`).join('; '),
    );
  }

  // ---- 发出范围投影：只评估作答面落在 issued parts 内的 unit。----
  const issuedParts =
    input.issued_part_ids == null
      ? new Set(revision.structure.parts.map((part) => part.part_id))
      : new Set(input.issued_part_ids);
  const inScopeSlots = answerableSlots(spec, issuedParts);
  const inScopeSlotIds = new Set(inScopeSlots.map((slot) => slot.slot_id));
  const slotById = new Map(inScopeSlots.map((slot) => [slot.slot_id, slot] as const));
  const inScopeUnits = basis.units.filter((unit) => unitInScope(unit, slotById));
  const inScopeUnitIds = new Set(inScopeUnits.map((unit) => unit.scoring_unit_id));

  // ---- 聚合 policy 投影：sum/weighted_sum 可按子集评估；capped/threshold
  //      的 cap/阈值绑死全量 unit 集，子集评估会改义 —— fail-closed。----
  const scopedBasis: ScoringBasisT = scopedBasisFor(basis, inScopeUnitIds);

  const entryBySlot = new Map(
    submission.response_set.entries.map((entry) => [entry.slot_id, entry] as const),
  );
  const materialById = new Map(
    revision.structure.materials.map((material) => [material.material_id, material] as const),
  );
  const assignmentByUnit = new Map<string, ExecutorDescriptorT>();
  for (const assignment of plan.assignments) {
    for (const unitId of assignment.scoring_unit_ids) {
      assignmentByUnit.set(unitId, assignment.executor);
    }
  }

  const runRefs: string[] = [];
  let spentCostMicros = 0;
  let modelUnitsInvoked = 0;
  const unitResults: ScoringUnitResultT[] = [];

  if (mode === 'manual_assert') {
    const asserted = input.asserted_unit_results ?? [];
    const seen = new Set<string>();
    let mismatch: string | null = null;
    for (const result of asserted) {
      const parsed = ScoringUnitResult.safeParse(result);
      if (!parsed.success) {
        mismatch = `asserted result for '${result.scoring_unit_id}' fails ScoringUnitResult schema`;
        break;
      }
      if (!inScopeUnitIds.has(result.scoring_unit_id)) {
        mismatch = `asserted result for unknown/out-of-scope unit '${result.scoring_unit_id}'`;
        break;
      }
      if (seen.has(result.scoring_unit_id)) {
        mismatch = `duplicate asserted result for unit '${result.scoring_unit_id}'`;
        break;
      }
      seen.add(result.scoring_unit_id);
      unitResults.push(parsed.data);
    }
    if (mismatch == null) {
      for (const unitId of inScopeUnitIds) {
        if (!seen.has(unitId)) {
          mismatch = `missing asserted result for in-scope unit '${unitId}'`;
          break;
        }
      }
    }
    if (mismatch != null) {
      throw new EvaluationContractError('manual_result_set_mismatch', mismatch);
    }
    const aggregate = aggregateUnitResults(scopedBasis, unitResults);
    return {
      record: EvaluationRecord.parse({
        evaluation_id: input.evaluation_id,
        evaluation_group_id: submission.evaluation_group_id,
        submission_id: submission.submission_id,
        attempt: input.attempt,
        status: 'completed',
        unit_results: unitResults,
        aggregate,
        plan_digest: input.plan_digest ?? null,
        run_refs: runRefs,
        provenance,
      }),
      model_units_invoked: modelUnitsInvoked,
      spent_cost_usd_micros: spentCostMicros,
    };
  }

  // ---- execute 模式：逐 unit 分发执行器。----
  for (const unit of inScopeUnits) {
    const unitId = unit.scoring_unit_id;
    const slotIds = [...unit.slot_refs, ...unit.evidence_slot_refs];
    const entries = slotIds
      .map((slotId) => entryBySlot.get(slotId))
      .filter((entry): entry is SlotResponseT => entry != null);

    // missing：声明作答面里存在缺条目（区别于主动空白）。
    const missingSlotIds = slotIds.filter((slotId) => !entryBySlot.has(slotId));
    if (missingSlotIds.length > 0) {
      unitResults.push(
        withUnit(pending({ reason: 'missing_response', slot_ids: missingSlotIds }), unitId),
      );
      continue;
    }

    // 空白：全部作答面显式空 —— 政策明确才计零，否则人工复核（绝不伪零分）。
    if (entries.length > 0 && entries.every(isBlankSlotResponse)) {
      if (basis.blank_scores_zero) {
        unitResults.push(
          withUnit(
            {
              status: 'scored',
              scoring_unit_id: '',
              points_awarded: unit.criterion.kind === 'holistic_level' ? null : 0,
              scored_because: 'blank_marked_zero',
              evidence_citations: [],
            },
            unitId,
          ),
        );
      } else {
        unitResults.push(
          withUnit(
            pending({
              reason: 'needs_review',
              trigger: 'flagged',
              detail:
                'submission is blank but basis.blank_scores_zero=false — explicit review required (no fake zero)',
            }),
            unitId,
          ),
        );
      }
      continue;
    }

    // 共享材料解析：material_refs 未解析在 contract 校验阶段已被
    // validateScoringBasis(unresolved_material_ref) 拦下（basis 与 structure
    // 同源）—— 运行期没有第二条「静态缺材料」路径；missing_materials 未决
    // 态由执行器端口如实上报（资产不可用/取不到），不在此重复静态判定。

    // group 证据：声明消费但本提交没有覆盖本 unit 的 group 证据 ⇒ 证据不足。
    if (unit.requires_group_evidence) {
      const covering = submission.group_evidence.some(
        (evidence) =>
          evidence.target.scope === 'all_units' ||
          evidence.target.scoring_unit_ids.includes(unitId),
      );
      if (!covering) {
        unitResults.push(
          withUnit(
            pending({
              reason: 'insufficient_evidence',
              detail: `unit '${unitId}' requires group evidence but none targets it`,
            }),
            unitId,
          ),
        );
        continue;
      }
    }

    // 格式不可解释：numeric 槽 value=null 且 raw_input 非空（P1-4：不是空白）。
    const unparseable = entries.find(
      (entry) =>
        entry.kind === 'numeric' &&
        entry.value === null &&
        (entry.raw_input ?? '').trim().length > 0,
    );
    if (unparseable != null && unparseable.kind === 'numeric') {
      unitResults.push(
        withUnit(
          pending({
            reason: 'unparseable_response',
            slot_id: unparseable.slot_id,
            detail: `numeric slot could not parse raw_input`,
          }),
          unitId,
        ),
      );
      continue;
    }

    // ---- 执行器分发 ----
    const executor = assignmentByUnit.get(unitId);
    if (executor == null) {
      // validateExecutionPlan 应已拦下；防御性 fail-closed。
      unitResults.push(
        withUnit(
          pending({ reason: 'unjudgeable', detail: 'no executor assignment for unit' }),
          unitId,
        ),
      );
      continue;
    }

    if (executor.kind === 'deterministic') {
      // 确定性比较器读第一个作答槽（判据↔槽位相容已由 validateExecutionPlan 保证）。
      const primaryEntry = entries.find((entry) => unit.slot_refs.includes(entry.slot_id));
      if (primaryEntry == null) {
        unitResults.push(
          withUnit(
            pending({
              reason: 'unjudgeable',
              detail: 'deterministic unit has no primary slot response',
            }),
            unitId,
          ),
        );
        continue;
      }
      unitResults.push(runDeterministicComparator(executor.comparator, unit, primaryEntry));
      continue;
    }

    if (executor.kind === 'human_review') {
      unitResults.push(
        withUnit(
          pending({
            reason: 'needs_review',
            trigger: 'manual_request',
            detail: 'execution plan assigns this unit to human review',
          }),
          unitId,
        ),
      );
      continue;
    }

    // model_executor —— D17 准入闸门。
    if (executor.admitted_slice_id === null) {
      const escalate = plan.escalation.on_unadmitted_model;
      unitResults.push(
        withUnit(
          pending(
            escalate === 'withhold'
              ? {
                  reason: 'unjudgeable',
                  detail: `model_executor slice unadmitted (D17); escalation=withhold`,
                }
              : {
                  reason: 'needs_review',
                  trigger: 'flagged',
                  detail: `model_executor slice unadmitted (D17); escalated to human_review`,
                },
          ),
          unitId,
        ),
      );
      continue;
    }
    if (input.model_executor == null) {
      unitResults.push(
        withUnit(
          pending({
            reason: 'infra_failure',
            retryable: true,
            detail: 'no model executor port registered for admitted slice',
          }),
          unitId,
        ),
      );
      continue;
    }
    // 预算闸门：计划级 max_total_cost 给确定性执行边界（已知上限的 executor
    // 才参与预算预检；executor.max_cost_usd_micros 未声明 ⇒ 无法预检，放行由
    // 端口自重 —— 事后成本计入 spentCostMicros）。
    if (
      plan.max_total_cost_usd_micros != null &&
      executor.max_cost_usd_micros != null &&
      spentCostMicros + executor.max_cost_usd_micros > plan.max_total_cost_usd_micros
    ) {
      unitResults.push(
        withUnit(
          pending({
            reason: 'unjudgeable',
            detail: `plan cost cap reached (${spentCostMicros}+${executor.max_cost_usd_micros} > ${plan.max_total_cost_usd_micros} micro USD)`,
          }),
          unitId,
        ),
      );
      continue;
    }

    const unitGroupEvidence = submission.group_evidence.filter(
      (evidence) =>
        evidence.target.scope === 'all_units' || evidence.target.scoring_unit_ids.includes(unitId),
    );
    modelUnitsInvoked += 1;
    let outcome: ModelUnitOutcomeT;
    try {
      const raw = await input.model_executor({
        submission_id: submission.submission_id,
        evaluation_group_id: submission.evaluation_group_id,
        revision_id: revision.revision_id,
        attempt: input.attempt,
        scoring_unit_id: unitId,
        executor,
        slot_responses: entries,
        group_evidence: unitGroupEvidence,
        materials: unit.material_refs
          .map((id) => materialById.get(id))
          .filter((material): material is SharedMaterialT => material != null),
        spent_cost_usd_micros: spentCostMicros,
      });
      const parsed = ModelUnitOutcome.safeParse(raw);
      if (!parsed.success) {
        unitResults.push(
          withUnit(
            pending({
              reason: 'infra_failure',
              retryable: false,
              detail: `model executor returned invalid outcome: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; ')}`,
            }),
            unitId,
          ),
        );
        continue;
      }
      outcome = parsed.data;
    } catch (err) {
      unitResults.push(
        withUnit(
          pending({
            reason: 'infra_failure',
            retryable: true,
            detail: `model executor threw: ${err instanceof Error ? err.message : String(err)}`,
          }),
          unitId,
        ),
      );
      continue;
    }

    runRefs.push(...outcome.run_refs);
    if (outcome.cost_usd_micros != null) spentCostMicros += outcome.cost_usd_micros;

    // 证据引用完整性：模型只报告证据，不得捏造（D17 zero severe errors）。
    const citationIssue =
      outcome.kind === 'scored'
        ? citationsResolve(
            outcome.evidence_citations,
            new Set(slotIds),
            collectKnownEvidenceIds(submission, entries),
          )
        : null;
    if (citationIssue != null) {
      unitResults.push(
        withUnit(
          pending({
            reason: 'needs_review',
            trigger: 'flagged',
            detail: `model outcome ${citationIssue} — fabricated citations are never trusted`,
          }),
          unitId,
        ),
      );
      continue;
    }

    // 低置信升级：只换执行器表现，不改给分规则。
    const lowConfidence =
      input.policy?.low_confidence_threshold != null &&
      outcome.confidence != null &&
      outcome.confidence < input.policy.low_confidence_threshold;
    if (lowConfidence && plan.escalation.on_low_confidence === 'human_review') {
      unitResults.push(
        withUnit(
          pending({
            reason: 'needs_review',
            trigger: 'low_confidence',
            detail: `confidence ${outcome.confidence} < threshold ${input.policy?.low_confidence_threshold}`,
          }),
          unitId,
        ),
      );
      continue;
    }

    if (outcome.kind === 'pending') {
      unitResults.push(
        withUnit({ status: 'pending', scoring_unit_id: '', pending: outcome.pending }, unitId),
      );
      continue;
    }
    unitResults.push(
      withUnit(
        {
          status: 'scored',
          scoring_unit_id: '',
          points_awarded: outcome.points_awarded,
          scored_because: 'response',
          ...(outcome.matched ? { matched: outcome.matched } : {}),
          ...(outcome.feedback_md ? { feedback_md: outcome.feedback_md } : {}),
          evidence_citations: outcome.evidence_citations,
        },
        unitId,
      ),
    );
  }

  const aggregate: AggregateOutcomeT = aggregateUnitResults(scopedBasis, unitResults);
  // 记录状态：retryable infra_failure ⇒ 本 attempt 未完成（pending，aggregate=null，
  // 供恢复/重投产生下一个 attempt）；其它 pending（unjudgeable/needs_review/...）
  // 是【终态未决】—— attempt 已完成，聚合如实落 unresolved(pending_units)。
  const hasRetryable = unitResults.some(
    (result) =>
      result.status === 'pending' &&
      result.pending.reason === 'infra_failure' &&
      result.pending.retryable,
  );
  const record = EvaluationRecord.parse({
    evaluation_id: input.evaluation_id,
    evaluation_group_id: submission.evaluation_group_id,
    submission_id: submission.submission_id,
    attempt: input.attempt,
    status: hasRetryable ? 'pending' : 'completed',
    unit_results: unitResults,
    aggregate: hasRetryable ? null : aggregate,
    plan_digest: input.plan_digest ?? null,
    run_refs: runRefs,
    provenance,
  });
  return {
    record,
    model_units_invoked: modelUnitsInvoked,
    spent_cost_usd_micros: spentCostMicros,
  };
}

/** 聚合 policy 按 in-scope unit 集投影；不可投影的聚合 fail-closed。 */
function scopedBasisFor(basis: ScoringBasisT, inScopeUnitIds: ReadonlySet<string>): ScoringBasisT {
  const units = basis.units.filter((unit) => inScopeUnitIds.has(unit.scoring_unit_id));
  if (units.length === basis.units.length) return basis;
  const aggregation = basis.aggregation;
  switch (aggregation.kind) {
    case 'sum':
      return { units, aggregation, blank_scores_zero: basis.blank_scores_zero };
    case 'weighted_sum': {
      const weights: Record<string, number> = {};
      for (const unit of units) {
        if (!(unit.scoring_unit_id in aggregation.weights)) {
          throw new EvaluationContractError(
            'unprojectable_aggregation',
            `weighted_sum missing weight for in-scope unit '${unit.scoring_unit_id}'`,
          );
        }
        weights[unit.scoring_unit_id] = aggregation.weights[unit.scoring_unit_id];
      }
      return {
        units,
        aggregation: { kind: 'weighted_sum', weights },
        blank_scores_zero: basis.blank_scores_zero,
      };
    }
    case 'capped_sum':
    case 'threshold_levels':
      throw new EvaluationContractError(
        'unprojectable_aggregation',
        `aggregation '${aggregation.kind}' is defined on the full unit set; a partial issuance scope cannot be evaluated without changing scoring semantics`,
      );
  }
}
