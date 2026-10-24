import { z } from 'zod';

// 规则只读比较结果的计数，不读题型、不解析显示内容或中文原文：
//   - set-compare 产生 hit / wrong / miss / picked / expected；
//   - 单空 exact 产生 correct (0|1)。
// 规则 = 按顺序命中的 cases + otherwise。when 是计数上的 eq/gt/gte/lt/lte，
// 同一对象内为 AND，可用 all/any 组合。award 只有四种：固定分、每命中分、
// 按命中 item 权重求和（均可 cap）、显式 unknown。没有脚本、循环或跨 unit
// 的隐式扣分。比较结果未知（missing / unreadable / undecidable）时不运行规则
// —— 那些是 pending，绝不落进 otherwise 的零分。

export const RuleMetric = z.enum(['hit', 'wrong', 'miss', 'picked', 'expected', 'correct']);
export type RuleMetricT = z.infer<typeof RuleMetric>;

const SET_METRICS: ReadonlySet<RuleMetricT> = new Set([
  'hit',
  'wrong',
  'miss',
  'picked',
  'expected',
]);

const Count = z.number().int().min(0);
export const RuleComparison = z
  .object({ eq: Count, gt: Count, gte: Count, lt: Count, lte: Count })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'empty comparison' });
export type RuleComparisonT = z.infer<typeof RuleComparison>;

export type RuleConditionT =
  | { all: RuleConditionT[] }
  | { any: RuleConditionT[] }
  | Partial<Record<RuleMetricT, RuleComparisonT>>;

export const RuleCondition: z.ZodType<RuleConditionT> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(RuleCondition).min(1) }).strict(),
    z.object({ any: z.array(RuleCondition).min(1) }).strict(),
    z
      .object({
        hit: RuleComparison,
        wrong: RuleComparison,
        miss: RuleComparison,
        picked: RuleComparison,
        expected: RuleComparison,
        correct: RuleComparison,
      })
      .partial()
      .strict()
      .refine((value) => Object.keys(value).length > 0, { message: 'empty condition' }),
  ]),
);

const Points = z.number().min(0).finite();

/** 分值未知的原因（统一设计 §3「unknown 的统一含义」中由规则表达的两类）。 */
export const RuleUnknownReason = z.enum(['partial_points_not_printed', 'points_not_printed']);
export type RuleUnknownReasonT = z.infer<typeof RuleUnknownReason>;

export const RuleOutcome = z.union([
  z.object({ points: Points }).strict(),
  z.object({ per_hit: Points, cap: Points.optional() }).strict(),
  z.object({ per_item: z.record(z.string().min(1), Points), cap: Points.optional() }).strict(),
  z.object({ unknown: RuleUnknownReason }).strict(),
]);
export type RuleOutcomeT = z.infer<typeof RuleOutcome>;

// 全部 strict：误写的键（如把 cases 写成 case）必须报错，不能被静默剥离后只剩 otherwise。
export const ScoringRule = z
  .object({
    version: z.literal(1),
    /** 印刷原文与来源定位；只作核验依据，判分时绝不解析。 */
    source: z
      .object({ statement: z.string().min(1), locator: z.string().min(1).optional() })
      .strict()
      .optional(),
    cases: z.array(z.object({ when: RuleCondition, award: RuleOutcome }).strict()).default([]),
    otherwise: RuleOutcome,
  })
  .strict();
export type ScoringRuleT = z.infer<typeof ScoringRule>;

// ---------- 求值 ----------

/** 比较结果（已知才运行规则）。set 计数与单空 correct 二选一。 */
export type RuleFacts =
  | {
      kind: 'set';
      hit: number;
      wrong: number;
      miss: number;
      picked: number;
      expected: number;
      hit_ids: readonly string[];
    }
  | { kind: 'single'; correct: 0 | 1 };

export type RuleCaseRef = number | 'otherwise';

export type RuleResult =
  | { kind: 'points'; points: number; rule_case: RuleCaseRef }
  | { kind: 'unknown'; reason: RuleUnknownReasonT; rule_case: RuleCaseRef };

function metricValue(facts: RuleFacts, metric: RuleMetricT): number | null {
  if (facts.kind === 'single') return metric === 'correct' ? facts.correct : null;
  return metric === 'correct' ? null : facts[metric];
}

function compare(value: number, comparison: RuleComparisonT): boolean {
  if (comparison.eq != null && !(value === comparison.eq)) return false;
  if (comparison.gt != null && !(value > comparison.gt)) return false;
  if (comparison.gte != null && !(value >= comparison.gte)) return false;
  if (comparison.lt != null && !(value < comparison.lt)) return false;
  if (comparison.lte != null && !(value <= comparison.lte)) return false;
  return true;
}

function matches(condition: RuleConditionT, facts: RuleFacts): boolean {
  if ('all' in condition && Array.isArray(condition.all)) {
    return condition.all.every((inner) => matches(inner, facts));
  }
  if ('any' in condition && Array.isArray(condition.any)) {
    return condition.any.some((inner) => matches(inner, facts));
  }
  return Object.entries(condition as Partial<Record<RuleMetricT, RuleComparisonT>>).every(
    ([metric, comparison]) => {
      const value = metricValue(facts, metric as RuleMetricT);
      // validateScoringRule 拒绝跨类指标；运行期防御性视为不命中。
      return value != null && comparison != null && compare(value, comparison);
    },
  );
}

/**
 * 卷面分值是十进制小数（0.5、0.1……）。乘加后按 1e-9 取整，避免 3×0.1 得出
 * 0.30000000000000004 而被聚合当成超过满分（发布校验用同一取整）。
 */
function roundAward(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function capped(value: number, cap: number | undefined): number {
  const rounded = roundAward(value);
  return cap == null ? rounded : Math.min(rounded, cap);
}

function applyOutcome(outcome: RuleOutcomeT, facts: RuleFacts, ref: RuleCaseRef): RuleResult {
  if ('unknown' in outcome) return { kind: 'unknown', reason: outcome.unknown, rule_case: ref };
  if ('points' in outcome) return { kind: 'points', points: outcome.points, rule_case: ref };
  const hits = facts.kind === 'set' ? facts.hit_ids : [];
  if ('per_hit' in outcome) {
    const count = facts.kind === 'set' ? facts.hit : facts.correct;
    return { kind: 'points', points: capped(count * outcome.per_hit, outcome.cap), rule_case: ref };
  }
  const sum = hits.reduce((total, id) => total + (outcome.per_item[id] ?? 0), 0);
  return { kind: 'points', points: capped(sum, outcome.cap), rule_case: ref };
}

/** 按顺序取第一条命中的 case，否则 otherwise。纯函数。 */
export function evaluateScoringRule(rule: ScoringRuleT, facts: RuleFacts): RuleResult {
  for (const [index, ruleCase] of rule.cases.entries()) {
    if (matches(ruleCase.when, facts)) return applyOutcome(ruleCase.award, facts, index);
  }
  return applyOutcome(rule.otherwise, facts, 'otherwise');
}

// ---------- 发布期校验 ----------

export interface ScoringRuleIssue {
  code:
    | 'rule_metric_not_applicable'
    | 'rule_outcome_not_applicable'
    | 'rule_item_not_in_key'
    | 'rule_exceeds_unit_points'
    | 'rule_key_response_not_full_marks';
  detail: string;
}

function collectMetrics(condition: RuleConditionT, into: Set<RuleMetricT>): void {
  if ('all' in condition && Array.isArray(condition.all)) {
    for (const inner of condition.all) collectMetrics(inner, into);
    return;
  }
  if ('any' in condition && Array.isArray(condition.any)) {
    for (const inner of condition.any) collectMetrics(inner, into);
    return;
  }
  for (const metric of Object.keys(condition)) into.add(metric as RuleMetricT);
}

function outcomeCeiling(outcome: RuleOutcomeT, keyIds: readonly string[]): number | null {
  if ('unknown' in outcome) return null;
  if ('points' in outcome) return outcome.points;
  const raw =
    'per_hit' in outcome
      ? outcome.per_hit * Math.max(keyIds.length, 1)
      : keyIds.reduce((total, id) => total + (outcome.per_item[id] ?? 0), 0);
  return capped(raw, outcome.cap);
}

/**
 * 规则与它的 unit 一致：
 *   - set 规则只用 set 指标，单空规则只用 correct；per_hit/per_item 只给 set；
 *   - per_item 的 key 必须是正确集合内的 item（权重只作用于命中项）；
 *   - 任何分支可达分值都不超过 unit.points；
 *   - 交出正确答案（set：恰好 key；单空：correct=1）必须得满分 unit.points。
 */
export function validateScoringRule(
  rule: ScoringRuleT,
  context:
    | { unitId: string; points: number; facts: 'set'; keyIds: readonly string[] }
    | {
        unitId: string;
        points: number;
        facts: 'single';
      },
): ScoringRuleIssue[] {
  const issues: ScoringRuleIssue[] = [];
  const outcomes = [...rule.cases.map((ruleCase) => ruleCase.award), rule.otherwise];
  const metrics = new Set<RuleMetricT>();
  for (const ruleCase of rule.cases) collectMetrics(ruleCase.when, metrics);
  for (const metric of metrics) {
    const isSetMetric = SET_METRICS.has(metric);
    if ((context.facts === 'set') !== isSetMetric) {
      issues.push({
        code: 'rule_metric_not_applicable',
        detail: `unit '${context.unitId}' rule reads '${metric}', which a ${context.facts} comparison does not produce`,
      });
    }
  }
  const keyIds = context.facts === 'set' ? context.keyIds : [];
  for (const outcome of outcomes) {
    if (context.facts === 'single' && ('per_item' in outcome || 'per_hit' in outcome)) {
      issues.push({
        code: 'rule_outcome_not_applicable',
        detail: `unit '${context.unitId}' single-answer rule cannot award per_hit/per_item`,
      });
    }
    if ('per_item' in outcome) {
      for (const id of Object.keys(outcome.per_item)) {
        if (!keyIds.includes(id)) {
          issues.push({
            code: 'rule_item_not_in_key',
            detail: `unit '${context.unitId}' per_item weight on '${id}', which is not in the key`,
          });
        }
      }
    }
    const ceiling = outcomeCeiling(outcome, keyIds);
    if (ceiling != null && ceiling > context.points + 1e-9) {
      issues.push({
        code: 'rule_exceeds_unit_points',
        detail: `unit '${context.unitId}' rule can award ${ceiling} > unit points ${context.points}`,
      });
    }
  }
  const keyFacts: RuleFacts =
    context.facts === 'set'
      ? {
          kind: 'set',
          hit: keyIds.length,
          wrong: 0,
          miss: 0,
          picked: keyIds.length,
          expected: keyIds.length,
          hit_ids: keyIds,
        }
      : { kind: 'single', correct: 1 };
  const keyResult = evaluateScoringRule(rule, keyFacts);
  if (
    keyResult.kind !== 'points' ||
    Math.abs(keyResult.points - context.points) > 1e-9 * Math.max(1, context.points)
  ) {
    issues.push({
      code: 'rule_key_response_not_full_marks',
      detail: `unit '${context.unitId}' rule gives the correct answer ${
        keyResult.kind === 'points' ? keyResult.points : 'unknown'
      } instead of full marks ${context.points}`,
    });
  }
  return issues;
}
