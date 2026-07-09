# YUK-579 UI Design Compliance Pre-flight 备料（2026-07-06，scout 侦察）

> 只读侦察产物。等 owner 拍板后才动 UI 代码。数据源侧发现改变 effort 估计（S-M → M）。

## 决策点（owner 需拍）

1. **归属未定**：`/admin/*` 第五页 vs Coach Hub 新 tab vs 其他。
   - 架构文档 `docs/design/2026-06-15-question-supply-target-discovery-architecture.md` Open Decision #2（「supply targets 该出现在 /inbox、/knowledge/[id] 还是 admin/observability」）**从未拍板**，Decision Recommendation 直接跳过了它。
   - 最贴近先例 calibration-maturity handoff（`docs/design/2026-06-19-calibration-maturity-panel-handoff.md`）自称「observability/admin 面（与 logs/cost/jobs 同侧）」，**但实际落点是 Coach Hub tab**（`src/capabilities/shell/ui/CoachCalibrationView.tsx`，loom 视觉全套），不是 `/admin/*`。
2. **admin 壳形态矛盾（顺带发现，本身值得收口）**：`docs/audit/2026-06-13-visual-gap.md:146,282` 说「SPA 收编主 chrome 时 admin 套不套主 chrome 须显式拍板」；但 `src/capabilities/observability/AGENTS.md:21-22` 已写死「admin 路由照常套主 chrome，不另设 admin 独立壳」——中间那次拍板**无 design doc/ADR 记录**。
3. **组件形态**：现有 admin 四页全是扁平 table/timeline（Card+PageHeader+Stateful+原生 table，inline CSSProperties 走 tokens），**无任何 2D cross-tab/heatmap 先例**。细目表要 nested table / 分组折叠 / heatmap，需要新设计。
4. **无 design doc 规定「新增 admin 观测子面」的布局规范**——calibration-maturity handoff 是流程先例（功能 handoff → claude design 视觉稿 → pre-flight），非视觉规范。

## 数据模型缺口（工程事实，影响 scope）

- `scanCoverageGaps`/`discoverSupplyTargets`（`src/server/question-supply/target-discovery.ts`）**只产出缺口 target，不产出「已覆盖」格**；四类判据（frontier_zero L387 / source_quality L405-407 / diagnostic L436-440 / format_diversity L456-457）中 R1/R2/R4 是 KC 池级判断，非逐 (kind,band,tier) 扫描。
- **渲染完整覆盖点阵需要新读模型**（在 ScanInput 之上做真交叉聚合，覆盖格+缺口格都出）。
- 两个 IO loader `loadFrontierKnowledge`(L554)/`loadQuestionPool`(L608) **未导出**——需新导出或包一层「只组装 ScanInput」的函数（守文件头「零新查询子系统」原则）。
- 无 `question_supply_target` 持久化表（架构文档的 MVP Table 未落地），`discoverSupplyTargets` 每次活扫描。

## API 先例（二选一，跟归属决策绑定）

- 先例 A：`/api/observability/calibration-maturity`（manifest.ts:55-59，`api/calibration-maturity.ts` 三行套路 db+errorResponse+Response.json）——新前缀，不挂 admin 四页横向导航。
- 先例 B：`/api/admin/subjects`（admin-subjects.ts，T4b）——挂 admin 四页导航；注意四页头部**硬编码兄弟页链接**（subjects.tsx:78-82），加页要同步改 observability.tsx + subjects.tsx。

## Touch 文件清单（按「admin 第五页」方案）

创建：`src/capabilities/observability/server/coverage-lattice.ts`（新读模型）、`api/coverage-lattice.ts`、`ui/coverage-lattice.tsx`。
修改：`target-discovery.ts`（导出 loader 或包层）、`observability/manifest.ts`（api.routes + ui.pages）、`web/src/router.tsx`（route + routeTree）、`ui/observability.tsx` + `ui/subjects.tsx`（兄弟链接）、`observability/AGENTS.md`（四页→五页）。
若落 Coach Hub 方案：改 `CoachHub.tsx`（163-165 tab 模式）+ `coach-hub-view.ts`（COACH_VIEWS），不动 router/manifest ui.pages。

## 编排者推荐

按 issue 字面「挂到 admin 观测四面旁」→ **admin 第五页 + 先例 B**，朴素只读 table（分组渲染，不做 heatmap 首版）；壳形态跟 AGENTS.md 现状（套主 chrome）并顺手补一条 ADR/design note 收口矛盾点 2。等 owner 批。
