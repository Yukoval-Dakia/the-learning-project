import { compareDeclaredBlank } from './blank-answer-compare';
import type { BlankAnswerShapeT } from './blank-answer-shape';
import type { ScoringUnitResultT } from './judgment';
import type { SlotResponseT } from './response';
import type { BlankKeyCriterionT, BlankNormalizationT, ScoringUnitT } from './scoring';
import { type RuleFacts, type RuleResult, evaluateScoringRule } from './scoring-rule';

// ====================================================================
// YUK-1496 — K1 确定性方法：set-compare 与单空 exact（统一设计 §3–§4）
// ====================================================================
//
// 由 evaluateSubmissionCore 的确定性分发调用（比较器 set_compare /
// blank_exact）—— 判分入口仍只有 evaluateSubmissionCore 一个；这里只负责
// 「比较 → 规则 → 单元结果」。比较结果未知（看不清、数值无法解释）返回
// pending，绝不让规则的 otherwise 把它判成零分。

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

/** 单空 exact 的版本化归一化；作答与参考走同一函数。 */
export function normalizeBlankText(text: string, normalization: BlankNormalizationT): string {
  let value = text;
  if (normalization.nfkc) value = value.normalize('NFKC');
  for (const [from, to] of normalization.character_variants) value = value.split(from).join(to);
  if (normalization.casefold) value = value.toLowerCase();
  if (normalization.ignore_punctuation) value = value.replace(/\p{P}/gu, '');
  if (normalization.collapse_whitespace) value = value.replace(/\s+/gu, ' ');
  if (normalization.trim_outer) value = value.trim();
  return value;
}

function charDiff(given: string, expected: string) {
  const a = [...given];
  const b = [...expected];
  if (a.length !== b.length) return undefined;
  const diff = a
    .map((char, offset) => ({ codepoint_offset: offset, given: char, expected: b[offset] }))
    .filter((entry) => entry.given !== entry.expected);
  return diff.length > 0 ? diff : undefined;
}

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * 纯数值读取：NFKC + trim + PLAIN_NUMBER + finite —— 不接受千分位/单位/其他形态。
 * 同一个确定性 parse 既用于判分（numericCorrect），也用于准入双解的跨 kind
 * 一致性（solve.ts keysAgree）：text 键铸成 numeric 键后，判分读法不变。
 */
export function parseBlankNumericText(raw: string): number | null {
  const text = raw.normalize('NFKC').trim();
  if (!PLAIN_NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function withinTolerance(
  value: number,
  key: Extract<BlankKeyCriterionT['key'], { kind: 'numeric' }>,
): boolean {
  const diff = Math.abs(value - key.expected);
  if (!Number.isFinite(value)) return false;
  if (key.tolerance.kind === 'absolute') return diff <= key.tolerance.value;
  return key.expected === 0 ? diff === 0 : diff / Math.abs(key.expected) <= key.tolerance.ratio;
}

/**
 * 数值空：无参考单位时只接受纯数值；有参考单位时用 mathjs 换算到参考单位，
 * 纯数值（漏写单位）按答错处理。无法解释的文本 → null（调用方给 pending）。
 */
async function numericCorrect(
  raw: string,
  key: Extract<BlankKeyCriterionT['key'], { kind: 'numeric' }>,
): Promise<0 | 1 | null> {
  const text = raw.normalize('NFKC').trim();
  if (key.expected_unit == null) {
    const value = parseBlankNumericText(raw);
    if (value == null) return null;
    return withinTolerance(value, key) ? 1 : 0;
  }
  if (PLAIN_NUMBER.test(text)) return 0;
  const { unit: parseUnit } = await import('mathjs');
  let reference: import('mathjs').Unit;
  try {
    reference = parseUnit(1, key.expected_unit);
  } catch {
    return null;
  }
  try {
    const given = parseUnit(text);
    if (!given.equalBase(reference)) return 0;
    return withinTolerance(given.toNumber(key.expected_unit), key) ? 1 : 0;
  } catch {
    return null;
  }
}

/**
 * 单空 exact：blank 作答对 blank_key，按 unit.rule 给分。
 *
 * declaredShape（YUK-1568 第 2 片）：冻结 slot 声明的 answer_shape（由
 * evaluation 按主槽位传入）。带声明时走同一共享比较核心 compareDeclaredBlank
 * （准入 keysAgree / 作者键核验 / 发布闸全部复用它，绝不两套数学）；无声明
 * 文本/数值完全保持原 normalizeBlankText + numericCorrect 行为。
 */
export async function gradeBlankExactUnit(
  unit: ScoringUnitT,
  entry: BlankEntry,
  declaredShape?: BlankAnswerShapeT,
): Promise<ScoringUnitResultT> {
  if (unit.criterion.kind !== 'blank_key' || unit.rule == null) {
    return unjudgeable(unit, 'blank_exact needs blank_key and a rule');
  }
  if (entry.state === 'unknown') {
    return unreadable(unit, entry.slot_id, 'handwriting was recorded as unreadable');
  }
  const key = unit.criterion.key;
  let correct: 0 | 1;
  let diff: ReturnType<typeof charDiff>;
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
    const given = normalizeBlankText(entry.text, key.normalization);
    const accepted = key.accepted.map((text) => normalizeBlankText(text, key.normalization));
    correct = accepted.includes(given) ? 1 : 0;
    if (correct === 0) {
      diff = accepted.map((text) => charDiff(given, text)).find((entry) => entry != null);
    }
  } else {
    const numeric = await numericCorrect(entry.text, key);
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
    diff == null ? { correct } : { correct, char_diff: diff },
    { correct_count: correct, total_count: 1 },
  );
}
