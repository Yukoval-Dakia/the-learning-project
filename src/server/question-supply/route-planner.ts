// YUK-361 Phase 8 (Task 13) — 供给目标路由规划（确定性约束规划器，MVP）。
//
// 权威 spec：
//   - docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md Task 13 Step 3
//   - docs/design/2026-06-15-question-supply-target-discovery-architecture.md §Route Planner
//
// 选题 vs 供给的镜像分工（架构 doc §Executive Summary）：选题从「现有 active 池」里挑；
// 供给目标发现决定「池缺什么、为什么重要、该走哪条获取线去补」。本模块只做后者的第三步——
// 把一个 QuestionSupplyTarget 翻成一个**有序的获取路由优先级列表**（SupplyRoute[]）。
//
// 纯函数：同输入同输出，无 IO、无 LLM、无写。dispatcher（同目录）才做 IO 派发。
// 约束优先级（Task 13 Step 3 字面给定的判据，权威）：
//   1. needsImage 约束 → 图源优先（图候选 → 既有录入 → web 兜底）。
//   2. minSourceTier ≤ 2（要中高可信源）→ web 既存题优先（web → 录入 → 拟题兜底）。
//   3. objectiveOnly 约束（要客观题，校准用）→ web 既存题或拟题（不走录入/图）。
//   4. 否则用 target.routePreference（若非空），再兜底 [author_question, sourcing_web]。
//
// 注意 minSourceTier 分支在 objectiveOnly 之前：一个既要高可信又只要客观题的目标，
// 高可信源约束更硬（校准级证据要 grounded），故先满足 minSourceTier ≤ 2 的 web-first 顺序。

import type { QuestionSupplyTarget, SupplyRoute } from './target-discovery';

/**
 * 把一个供给目标翻成有序的获取路由优先级列表。
 *
 * 判据顺序见文件头。`target.routePreference` 由扫描器据 subject profile 的
 * `sourcingRoutePreference` 播种（见 target-discovery.ts seedRoutePreference）——只有在
 * 没有更硬的约束（图/高可信源/客观题）触发时才用它，否则约束优先链覆盖偏好。
 */
export function planSupplyRoutes(target: QuestionSupplyTarget): SupplyRoute[] {
  if (target.constraints.needsImage) {
    return ['image_candidate', 'ingest_existing', 'sourcing_web'];
  }
  if (target.minSourceTier <= 2) {
    return ['sourcing_web', 'ingest_existing', 'author_question'];
  }
  if (target.constraints.objectiveOnly) {
    return ['sourcing_web', 'author_question'];
  }
  return target.routePreference.length > 0
    ? target.routePreference
    : ['author_question', 'sourcing_web'];
}
