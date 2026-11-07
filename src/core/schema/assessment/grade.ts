import {
  type AnswerCharDiff,
  type BlankTextComparisonEntry,
  type FinalAnswerEvidence,
  compareBlankTextAnswer,
  compareNumericBlankAnswer,
  normalizeNumericKeyInput,
} from './answer-compare';
import { compareDeclaredBlank } from './blank-answer-compare';
import type { BlankAnswerShapeT } from './blank-answer-shape';
import type { ScoringUnitResultT } from './judgment';
import type { SlotResponseT } from './response';
import type { BlankKeyCriterionT, ScoringUnitT } from './scoring';
import { type RuleFacts, type RuleResult, evaluateScoringRule } from './scoring-rule';

// ====================================================================
// K1 确定性方法：set-compare 与单空 exact（统一设计 §3–§4）
// ====================================================================
//
// 由 evaluateSubmissionCore 的确定性分发调用（比较器 set_compare /
// blank_exact）—— 判分入口仍只有 evaluateSubmissionCore 一个；这里只负责
// 「比较 → 规则 → 单元结果」。归一化与比较判定归 answer-compare（单 owner）；
// 比较结果未知（看不清、数值无法解释）返回 pending，绝不让规则的 otherwise
// 把它判成零分。

type SelectEntry = Extract<SlotResponseT, { kind: 'select' }>;
type BlankEntry = Extract<SlotResponseT, { kind: 'blank' }>;

export interface SetComparison {
  hit: number;
  wrong: number;
  miss: number;
  picked: number;
  expected: number;
  hit_ids: string[];
  wrong_ids: string[];
  miss_ids: string[];
}

/** 集合比较：hit=|R∩K|、wrong=|R−K|、miss=|K−R|。与提交顺序无关。 */
export function compareItemSets(picked: readonly string[], key: readonly string[]): SetComparison {
  const keySet = new Set(key);
  const pickedSet = new Set(picked);
  const hitIds = [...pickedSet].filter((id) => keySet.has(id));
  const wrongIds = [...pickedSet].filter((id) => !keySet.has(id));
  const missIds = [...keySet].filter((id) => !pickedSet.has(id));
  return {
    hit: hitIds.length,
    wrong: wrongIds.length,
    miss: missIds.length,
    picked: pickedSet.size,
    expected: keySet.size,
    hit_ids: hitIds,
    wrong_ids: wrongIds,
    miss_ids: missIds,
  };
}

function unreadable(unit: ScoringUnitT, slotId: string, detail: string): ScoringUnitResultT {
  return {
    status: 'pending',
    scoring_unit_id: unit.scoring_unit_id,
    pending: { reason: 'unparseable_response', slot_id: slotId, detail },
  };
}

function reviewPending(unit: ScoringUnitT, detail: string): ScoringUnitResultT {
  return {
    status: 'pending',
    scoring_unit_id: unit.scoring_unit_id,
    pending: { reason: 'needs_review', trigger: 'flagged', detail },
  };
}

function unjudgeable(unit: ScoringUnitT, detail: string): ScoringUnitResultT {
  return {
    status: 'pending',
    scoring_unit_id: unit.scoring_unit_id,
    pending: { reason: 'unjudgeable', detail: `K1 comparator could not apply: ${detail}` },
  };
}

function scoredFromRule(
  unit: ScoringUnitT,
  slotId: string,
  result: RuleResult,
  comparison: Omit<
    NonNullable<Extract<ScoringUnitResultT, { status: 'scored' }>['comparison']>,
    'rule_case'
  >,
  partialCounts: { correct_count: number; total_count: number },
): ScoringUnitResultT {
  const base = {
    status: 'scored' as const,
    scoring_unit_id: unit.scoring_unit_id,
    scored_because: 'response' as const,
    comparison: { ...comparison, rule_case: result.rule_case },
    evidence_citations: [{ slot_id: slotId }],
  };
  if (result.kind === 'points') return { ...base, points_awarded: result.points };
  return {
    ...base,
    points_awarded: null,
    partial_unknown_points: { ...partialCounts, reason: result.reason },
  };
}

/** set-compare：select 作答对 select_key，按 unit.rule 给分。 */
export function gradeSelectUnit(unit: ScoringUnitT, entry: SelectEntry): ScoringUnitResultT {
  if (unit.criterion.kind !== 'select_key' || unit.rule == null) {
    return unjudgeable(unit, 'set_compare needs select_key and a rule');
  }
  if (entry.state === 'unknown') {
    return unreadable(unit, entry.slot_id, 'selection was recorded as unreadable');
  }
  const comparison = compareItemSets(entry.item_ids, unit.criterion.accepted_item_ids);
  const facts: RuleFacts = { kind: 'set', ...comparison };
  return scoredFromRule(
    unit,
    entry.slot_id,
    evaluateScoringRule(unit.rule, facts),
    { set: comparison },
    {
      correct_count: comparison.hit,
      total_count: comparison.expected,
    },
  );
}

/**
 * 单空 exact 的唯一实现；两个导出入口只决定文本空的比较语义：
 * 学习者判分含过程作答终态救援，准入作者键核验只比整段答案形式。
 */
async function gradeBlankExactUnitCore(
  unit: ScoringUnitT,
  entry: BlankEntry,
  declaredShape: BlankAnswerShapeT | undefined,
  comparisonEntry: BlankTextComparisonEntry,
): Promise<ScoringUnitResultT> {
  if (unit.criterion.kind !== 'blank_key' || unit.rule == null) {
    return unjudgeable(unit, 'blank_exact needs blank_key and a rule');
  }
  if (entry.state === 'unknown') {
    return unreadable(unit, entry.slot_id, 'handwriting was recorded as unreadable');
  }
  const key: BlankKeyCriterionT['key'] = unit.criterion.key;
  if (key.kind === 'numeric' && normalizeNumericKeyInput(entry.text, key) == null) {
    return unreadable(
      unit,
      entry.slot_id,
      'numeric answer contains unsupported compatibility symbols',
    );
  }
  let correct: 0 | 1;
  let diff: AnswerCharDiff | undefined;
  let finalAnswer: FinalAnswerEvidence | undefined;
  if (declaredShape != null) {
    // 声明数学路径：作答与键同一解析器；undecidable（解析失败/歧义/超限/
    // 键与声明确定性冲突）→ pending，绝不伪零分；完整解析但不相等 →
    // incorrect，由原 rule 给分。
    const declared = await compareDeclaredBlank(declaredShape, key, entry.text);
    if (declared.outcome === 'undecidable') {
      return unreadable(unit, entry.slot_id, `declared answer_shape: ${declared.reason}`);
    }
    correct = declared.outcome === 'correct' ? 1 : 0;
  } else if (key.kind === 'text') {
    const comparison = compareBlankTextAnswer(key, entry.text, comparisonEntry);
    if (comparison.outcome === 'undecidable') {
      return reviewPending(unit, comparison.detail);
    }
    correct = comparison.outcome === 'correct' ? 1 : 0;
    if (comparison.outcome === 'correct') finalAnswer = comparison.finalAnswer;
    diff = comparison.outcome === 'incorrect' ? comparison.charDiff : undefined;
  } else {
    const numeric = await compareNumericBlankAnswer(key, entry.text);
    if (numeric == null) {
      return unreadable(unit, entry.slot_id, 'numeric answer cannot be read as a supported value');
    }
    correct = numeric;
  }
  const facts: RuleFacts = { kind: 'single', correct };
  return scoredFromRule(
    unit,
    entry.slot_id,
    evaluateScoringRule(unit.rule, facts),
    diff != null
      ? { correct, char_diff: diff }
      : finalAnswer != null
        ? { correct, final_answer: finalAnswer }
        : { correct },
    { correct_count: correct, total_count: 1 },
  );
}

/**
 * 学习者判分入口：含 YUK-1407 过程作答终态救援。declaredShape 为冻结 slot
 * 声明的 answer_shape（由 evaluation 按主槽位传入），带声明时走共享数学核心
 * compareDeclaredBlank；无声明文本/数值的归一化与比较全部归 answer-compare。
 */
export function gradeBlankExactUnit(
  unit: ScoringUnitT,
  entry: BlankEntry,
  declaredShape?: BlankAnswerShapeT,
): Promise<ScoringUnitResultT> {
  return gradeBlankExactUnitCore(unit, entry, declaredShape, 'learner_grading');
}

/**
 * 准入作者键核验入口：只比整段答案形式，不做过程作答救援。
 * 求解侧别名是候选答案而不是推导稿；整段不等就是 incorrect。
 */
export function gradeBlankAuthorKeyUnit(
  unit: ScoringUnitT,
  entry: BlankEntry,
  declaredShape?: BlankAnswerShapeT,
): Promise<ScoringUnitResultT> {
  return gradeBlankExactUnitCore(unit, entry, declaredShape, 'admission_author_key');
}
