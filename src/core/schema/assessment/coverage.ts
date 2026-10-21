import type { DeterministicComparatorIdT } from './execution';
import { EvidenceKind } from './materials';
import { PendingState } from './pending';
import { ResponseSlot } from './response';

// ====================================================================
// YUK-1056 — 能力覆盖矩阵（grounding §15 常量审计口径）
// ====================================================================
//
// 统一评估契约的能力覆盖按四档区分（ticket 口径）：
//   - expressible（可表达）：ResponseSpec 判别联合能否声明该作答要求；
//   - collectable（可采集）：当前作答面/输入链能否产出该 kind 的 ResponseSet 条目；
//   - auto_scorable（可自动评分）：判分执行器通道 —— deterministic 比较器 /
//     D17 已准入 model_executor / 未准入 / 无通道；
//   - manual_evidence（需人工证据）：确定性通道不存在且模型切片未准入时，
//     human_review / D9 manual provenance 是【当前唯一】诚实路径。
//
// 诚实化纪律（§4.1 fail-closed 同款）：
//   - 「声明了但实际没有 runner」的假能力不标 covered —— formula/ordering/
//     open_response 今天【没有】确定性比较器，模型切片未经 D17 准入，故
//     manual_evidence=true；这不是缺陷声明，是准入前的诚实表达。
//   - table 是布局容器：不直接作答、不直接计分，单元格按自身原语各自评估。
//   - ResponseSet 投递链（作答面 → evaluation_record）尚未接线，
//     collectable 档按「契约 + 现有输入原语能否承载」评估。

/** ResponseSlot 判别联合的 kind 词表（从 zod 联合 option 派生 —— 单源）。 */
export const RESPONSE_SLOT_KINDS = ResponseSlot.options.map(
  (o) => o.shape.kind.value,
) as unknown as readonly [
  'single_choice',
  'multi_choice',
  'text',
  'numeric',
  'formula',
  'table',
  'matching',
  'ordering',
  'open_response',
  'sentence_breaks',
  'select',
  'blank',
];
export type ResponseSlotKindT = (typeof RESPONSE_SLOT_KINDS)[number];

/** D10 原始证据种类（image/audio/video/pdf/plaintext 并列；类型见 materials.EvidenceKindT）。 */
export const EVIDENCE_KINDS = EvidenceKind.options;

/** 显式未决态 reason 词表（绝不冒充分数）。 */
export const PENDING_REASONS = PendingState.options.map(
  (o) => o.shape.reason.value,
) as readonly string[];

export type CoverageTier = 'covered' | 'partial' | 'gap';
export type AutoScorableChannel =
  | 'deterministic'
  | 'model_admitted'
  | 'model_unadmitted'
  | 'container';

export interface ResponsePrimitiveCoverage {
  slot_kind: ResponseSlotKindT;
  /** 契约可表达 —— 联合成员恒 covered（表达性是 ResponseSpec 的成立前提）。 */
  expressible: 'covered';
  /** 当前采集链可达性：covered=输入原语+投递链齐备；partial=输入原语在、ResponseSet 投递链未接线；gap=无输入原语。 */
  collectable: CoverageTier;
  /** 自动评分通道（container 表示自身不计分）。 */
  auto_scorable: AutoScorableChannel;
  /** 对应的确定性比较器（无则 null —— 不得虚构）。 */
  deterministic_comparator: DeterministicComparatorIdT | null;
  /** 当前需要人工证据/人工复核作为诚实路径（模型切片未准入或证据需人工判读）。 */
  manual_evidence_required: boolean;
  notes: string;
}

/**
 * 能力覆盖矩阵（§15 口径）。行顺序 = RESPONSE_SLOT_KINDS。
 * 任何原语枚举扩张必须在这里补一行 —— unit test 断言全量覆盖。
 */
export const CAPABILITY_COVERAGE_MATRIX: readonly ResponsePrimitiveCoverage[] = [
  {
    slot_kind: 'single_choice',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'exact_option_set',
    manual_evidence_required: false,
    notes:
      'stable option id 集合语义；exact_option_set 比较器产 option_set_key 判据（normalizer 已落位）。collectable=partial：legacy choice 输入面存在，ResponseSet 投递链未接线。',
  },
  {
    slot_kind: 'multi_choice',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'exact_option_set',
    manual_evidence_required: false,
    notes:
      'min/max_select 显式约束；多答案键 normalizer 已产 multi_choice + option_set_key（不再塞 single_choice）。collectable=partial 同上。',
  },
  {
    slot_kind: 'text',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'exact_text',
    manual_evidence_required: false,
    notes:
      'text_key 判据走 exact_text；rule_reference 判据需 model_executor（未准入 → unjudgeable/escalate，不冒充）。collectable=partial 同上。',
  },
  {
    slot_kind: 'numeric',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'numeric_tolerance',
    manual_evidence_required: false,
    notes:
      'numeric_key 支持 numeric_tolerance（原字面单位）与显式 numeric_unit_conversion（mathjs解释原文/换算，仅用发布容差，无固定部分分）。不可解析原文保持未决；collectable=partial 同上。',
  },
  {
    slot_kind: 'formula',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'model_unadmitted',
    deterministic_comparator: null,
    manual_evidence_required: true,
    notes:
      'LaTeX 作答无确定性比较器；语义等价/化简判分需 model_executor，D17 切片未准入 ⇒ 当前诚实路径 = human_review/manual provenance（绝不伪造成 deterministic）。',
  },
  {
    slot_kind: 'table',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'container',
    deterministic_comparator: null,
    manual_evidence_required: false,
    notes:
      '布局容器：cells 引用同 part 的子槽位，每格按自身原语作答与计分（混合响应与整题计分不一一绑定，§7.2）。collectable=partial：cell 采集随子槽。',
  },
  {
    slot_kind: 'matching',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'exact_matching_pairs',
    manual_evidence_required: false,
    notes:
      'left items × right options；ID 对选择即可作答（不要求拖拽 UI，§7.2）；exact_matching_pairs 比较器。collectable=partial 同上。',
  },
  {
    slot_kind: 'ordering',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'model_unadmitted',
    deterministic_comparator: null,
    manual_evidence_required: true,
    notes:
      '排列判分无确定性比较器（部分序/位置分属 scoring 政策）；需 model_executor，未准入 ⇒ human_review/manual。collectable=partial：序号编辑输入可行，ResponseSet 链未接线。',
  },
  {
    slot_kind: 'open_response',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'model_unadmitted',
    deterministic_comparator: null,
    manual_evidence_required: true,
    notes:
      '开放作答 + D10 证据附件（audio/video/pdf/plaintext/image 并列）。无确定性通道；证据不可读/不足走 unreadable_evidence/insufficient_evidence 未决（不造分）。collectable=partial：附件上传面在 ingestion，ResponseSet 链未接线。',
  },
  {
    slot_kind: 'sentence_breaks',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'position_set_rule',
    manual_evidence_required: false,
    notes:
      'ADR-0074 D3a 断句：冻结明文的 code point 字缝点选（position-gap.ts 语义）；position_set_key 判据（接受断点集合 + 题级 typed 规则，私有）由 position_set_rule 确定性判分；无印规则的非精确集合记对数并 needs_review（分数未知不造分）。collectable=partial：R10 字间点选 UI 属界面线，ResponseSet 投递链未接线。',
  },
  {
    slot_kind: 'select',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'set_compare',
    manual_evidence_required: false,
    notes:
      'YUK-1496 K1 统一选择：选项、配对关系、断句字缝、排序关系都是稳定 item；select_key + 显式给分规则由 set_compare 判分，规则可给 unknown（不造分）。collectable=partial（YUK-1497）：网页由展示层输入积木（option_list / matching_columns / break_tap / ordering）作答并经 ResponseSet 提交；没有展示层、或只被自定义块绑定的槽，出题门以 no_input_renderer 扣发。',
  },
  {
    slot_kind: 'blank',
    expressible: 'covered',
    collectable: 'partial',
    auto_scorable: 'deterministic',
    deterministic_comparator: 'blank_exact',
    manual_evidence_required: false,
    notes:
      'YUK-1496 K1 单空：文本按版本化归一化逐字比较，数值保留容差与单位换算；Jev 等价判断待准入（model_executor）。collectable=partial（YUK-1497）：网页由 blank_input 积木作答，整题提交时空着的空交 state=blank；没有展示层、或只被自定义块绑定的槽，出题门以 no_input_renderer 扣发。',
  },
];

export const CAPABILITY_COVERAGE_VERSION = '1' as const;

/** 逐 kind 查覆盖行（缺行 = 契约扩张未登记 —— 审计口径下视为 gap）。 */
export function coverageFor(slotKind: ResponseSlotKindT): ResponsePrimitiveCoverage | undefined {
  return CAPABILITY_COVERAGE_MATRIX.find((row) => row.slot_kind === slotKind);
}
