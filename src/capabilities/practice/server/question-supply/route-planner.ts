// Deterministic supply-route planner: turn one QuestionSupplyTarget into an ordered list of
// acquisition routes. Pure: no IO, no LLM, no writes; dispatcher performs IO.
//
// Constraint order:
// 1. compositeParentOnly -> quiz_gen only (the only producer of parent+part rows);
// 2. needsImage -> image candidate, then ingest, then web;
// 3. minSourceTier <= 2 -> web first, then ingest, then authoring;
// 4. confusable_contrast with an explicit preference keeps quiz_gen;
// 5. objectiveOnly -> web or authoring;
// 6. otherwise target.routePreference, then [author_question, sourcing_web].
// The tier constraint precedes objectiveOnly because grounded high-trust evidence is the
// harder requirement.

import type { QuestionSupplyTarget, SupplyRoute } from './target-discovery';

/**
 * 把一个供给目标翻成有序的获取路由优先级列表。
 *
 * 判据顺序见文件头。`target.routePreference` 由扫描器据 subject profile 的
 * `sourcingRoutePreference` 播种（见 target-discovery.ts seedRoutePreference）——只有在
 * 没有更硬的约束（图/高可信源/客观题）触发时才用它；唯一例外是
 * `confusable_contrast`，其显式 routePreference 在通用 objectiveOnly 分支前生效，
 * 以保留 quiz_gen 辨析题生成路线。
 *
 * (Supply-Agent/1) — jyeoo_fetch 路由的机器面（queue/handler/dispatcher
 * 分支）已退役：producer 经济学（无法按 KC 定向 + 40题/日预算）与逐目标派发根本
 * 不兼容，供给改由 agent tool 链（jyeoo_fetch_candidates / store_sourced_question）
 * 承载。'jyeoo_fetch' 仅保留在 SupplyRoute/SupplyProducerRoute **词表**里（trace 与
 * provenance 的合法值），本 planner 不再产出它。
 */
export function planSupplyRoutes(target: QuestionSupplyTarget): SupplyRoute[] {
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
    return ['sourcing_web', 'ingest_existing', 'author_question'];
  }
  if (target.gapKind === 'confusable_contrast' && target.routePreference.length > 0) {
    return target.routePreference;
  }
  if (target.constraints.objectiveOnly) {
    return ['sourcing_web', 'author_question'];
  }
  return target.routePreference.length > 0
    ? target.routePreference
    : ['author_question', 'sourcing_web'];
}
