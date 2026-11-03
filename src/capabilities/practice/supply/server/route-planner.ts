// Deterministic supply-route planner: turn one QuestionSupplyTarget into an ordered list of
// acquisition routes. Pure: no IO, no LLM, no writes; dispatcher performs IO.
//
// Constraint order:
// 1. compositeParentOnly -> quiz_gen only (the only producer of parent+part rows);
// 2. needsImage -> image candidate, then ingest, then web;
// 3. minSourceTier <= 2 -> jyeoo first when jyeooEligible, then web, ingest, authoring;
// 4. objectiveOnly -> web or authoring;
// 5. otherwise target.routePreference, then [author_question, sourcing_web].
// The tier constraint precedes objectiveOnly because grounded high-trust evidence is the
// harder requirement.

import type { QuestionSupplyTarget, SupplyRoute } from './target-discovery';

export interface SupplyRouteOptions {
  /**
   * Today's remaining jyeoo fetch budget. Only question_supply_nightly passes it, so the
   * nightly scan is the only caller whose targets can route to the paid jyeoo fetch.
   */
  jyeooBudgetRemaining?: number;
}

// The supply_execute jyeoo defaults fetch the 高中数学 corpus (subject 'math2').
const JYEOO_CORPUS_SUBJECT_ID = 'math';

/**
 * Deterministic form of the retired supply planner's jyeoo condition ("real-exam style
 * wanted and budget enough"): the gap asks for a sourced item (tier <= 2), the subject is
 * the one the jyeoo corpus covers, and today's remaining budget covers the gap's count.
 * Kind-constrained gaps stay off jyeoo because the grade route cannot honour them. The
 * executor re-checks the budget before fetching and falls through to the next route.
 */
function jyeooEligible(target: QuestionSupplyTarget, options: SupplyRouteOptions): boolean {
  const budget = options.jyeooBudgetRemaining;
  return (
    budget !== undefined &&
    budget >= target.desiredCount &&
    target.minSourceTier <= 2 &&
    target.subjectId === JYEOO_CORPUS_SUBJECT_ID &&
    !target.constraints.objectiveOnly &&
    !target.constraints.kindRequired &&
    target.placementStarter === undefined
  );
}

/**
 * 把一个供给目标翻成有序的获取路由优先级列表。
 *
 * 判据顺序见文件头。`target.routePreference` 由扫描器据 subject profile 的
 * `sourcingRoutePreference` 播种（见 target-discovery.ts seedRoutePreference）——只有在
 * 没有更硬的约束（图/高可信源/客观题）触发时才用它。
 *
 * jyeoo_fetch 只在 `jyeooEligible` 成立时排在高可信分支首位；它经 supply_execute 执行，
 * 同一 job 内抓取不足再走 web，派发数仍受夜扫每轮上限约束。
 */
export function planSupplyRoutes(
  target: QuestionSupplyTarget,
  options: SupplyRouteOptions = {},
): SupplyRoute[] {
  // 篇 (composite parent) is a STRUCTURAL hard constraint: the pool
  // filter requires a parent row with ≥1 question_part child, and quiz_gen is
  // the only producer that materializes parent+part groups (sourcing_web /
  // ingest_existing store flat rows; author_question writes a structured tree
  // but no part rows). Checked BEFORE needsImage: that flag only biases routing
  // (no pool predicate), so a combined needsImage+composite demand can only
  // ever be fulfilled on the composite axis.
  if (target.constraints.compositeParentOnly) {
    return ['quiz_gen'];
  }
  if (target.constraints.needsImage) {
    return ['image_candidate', 'ingest_existing', 'sourcing_web'];
  }
  if (target.minSourceTier <= 2) {
    return jyeooEligible(target, options)
      ? ['jyeoo_fetch', 'sourcing_web', 'ingest_existing', 'author_question']
      : ['sourcing_web', 'ingest_existing', 'author_question'];
  }
  if (target.constraints.objectiveOnly) {
    return ['sourcing_web', 'author_question'];
  }
  return target.routePreference.length > 0
    ? target.routePreference
    : ['author_question', 'sourcing_web'];
}
