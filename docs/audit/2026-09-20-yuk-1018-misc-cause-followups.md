# YUK-1018 — 454-A 下游语义跟进：misc 显示回填 / 邻近召回 / 观察项记录

日期：2026-09-20 · 分支 `yuk-1018-454a-followups` · 基线 `8d57b8d00`（含 #1429）

454-A（YUK-1015，PR #1425）让 `misc_<sha256-24>` 成为合法 stored cause id，但落库后的
消费面只渲染裸 id。本票处理三个下游语义项。

## Item 1 — misc cause 显示回填（已实施）

裸 `misc_<hash>` 出现在四个读面：question timeline、`/api/mistakes` 投影、copilot
`attribute_mistake`/`query_mistakes`/`get_attempt_context`/`question_context` 输出、
session/weekly summary 的 `top_causes`。统一在读模型层回填 display label：

- 新 kernel read-model `src/kernel/read-models/misc-cause-labels.ts`：
  `resolveMiscCauseLabels(db, ids)` 批量直查 `misconception` 表（kernel 不能 import
  capability；直查表有 `cause-overlay.ts` 先例）。只解析 active 且未 archive 的行；
  `misc_` 前缀收进共享常量 `MISC_CAUSE_ID_PREFIX`（practice 的
  `MISCONCEPTION_CANDIDATE_PREFIX` 改为别名防漂移）。
- 语义：id 保留在原字段（`primary`/`primary_category`/`category` 不动），label 走新增的
  可空字段 `primary_label`/`cause_label`/`category_label`。unresolvable（不存在或已
  archive）→ `null`，调用方/UI 回退裸 id；词表 id（`concept` 等）恒 `null`，不做误查。
- `getCauseLabel` 保持纯函数不动（无 DB 访问，且零消费方）。
- UI（已获 design pre-flight 批准）：`CauseBadge`/`AttemptTimeline`/`MistakesPage` 渲染
  `primary_label ?? primary`；`CoachHub` 渲染 `category_label ?? CAUSE_LABELS[category] ??
  category`。**复发计数仍按裸 `primary` 分组**——id 是语义身份，label 只是显示。

## Item 2 — 邻近召回评估（已实施：祖先方向，裁掉后代方向）

`listActiveMisconceptionsForKcs` 原本只匹配 attempt `knowledge_context` 直挂 KC。
评估结论：

- **祖先方向：纳入。** 挂在祖先 KC 的 misc 对后代 KC 的失败是合法解释（例如「文言虚词」
  节点的误区可以解释其子孙「之」字用法题的失败）。实现：kernel
  `batchResolveAncestorIds`（全树一次加载 + 内存爬升，`MAX_DEPTH=32` 防环），在
  `failure-learning-attribution` 调用点把 attempt KC 与祖先做并集后再调
  `listActiveMisconceptionsForKcs`——后者保持纯 join primitive 不动。
- **后代方向：裁掉。** parent KC 的 attempt 召回只挂在 child 上的 misc 是噪声源
  （parent 失败不等于 child 误区），且会随树深放大 candidate 集合。不做，此为本票的
  显式裁决而非遗漏。
- candidate 膨胀：misc 侧 cap=50 不变；祖先链在典型树深（≤5）下只增加个位数 KC，
  union 仍远小于 K_SMALL 触发阈（见观察项 3 的边界注记）。

## Item 3 — 观察项（按票要求只记录，不裁解）

1. **evidence cell 粒度分裂**：(primary_category × KC) 复发 cell 被 misc id 细分——
   细粒度是设计意图，但同一模式分散在 `concept` 与 `misc_x` 两个 cell 会摊薄复发计数。
   **触发点**：L3 recurrence 启用评估（454-C 已 NO-GO，等数据基底）时需先定 cell 归并
   策略（如 misc id → 归属词表类 + misc 子键）。
2. **二代 misc**：misc id 作 causeCategory 进 `misconceptionIdForConjecture` →
   `misc_sha256('misc_x::kc')` 二代节点。语义合法（误区的子误区），但 promote 流是否
   放行需要 owner 裁决——当前 `MISCONCEPTION_PROMOTE_ENABLED=true` 已部署，若 accept 一
   条 causeCategory 为 misc id 的 conjecture 会真实 mint 二代节点。**建议**：观察首个自
   然出现的二代 proposal，届时按「子误区是否值得独立追踪」裁决；如需禁止，拦截点在
   promote applier。
3. **union > K_SMALL 极端**：misc cap 50 下 union 可超 K_SMALL 触发 scorer，大量 misc
   可挤占 vocab 候选。当前 promote 刚启用、misc 总量近零，纯理论边界。**触发点**：
   misc 数量上量后复核 retrieve 候选构成（attribution trace 里有 candidate 计数）。

## 验证

- `misc-cause-labels.db.test.ts`（新增）：可解析/不可解析/词表 id 三分支。
- `knowledge-tree.db.test.ts`：祖先链解析（含环防护）。
- `failure-learning-attribution.db.test.ts`：祖先 KC 的 misc 进候选、后代 KC 的不进。
- `detail.test.ts` / `mistakes.db.test.ts` / `weekly.db.test.ts` / `summary.test.ts` /
  copilot 工具测试：label 字段贯穿与 null 回退。
- UI unit：`AttemptTimeline` 渲染 label、复发仍按裸 id 分组；adapter 透传。

## 遗留

- 生产部署：本批代码随下一次 `up -d --build` 生效（当前生产镜像无 454 代码）。
- 观察项 2 的 owner 裁决挂起——首个二代 misc proposal 出现时回看本节。
