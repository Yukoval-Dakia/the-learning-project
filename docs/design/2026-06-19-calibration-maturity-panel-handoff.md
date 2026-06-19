# 校准成熟度面板 — 功能 handoff（给 claude design）

- **date**: 2026-06-19
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **数据已就位**: 后端 read-model + endpoint 已落地（PR #475，YUK-348）

> 这是**功能** handoff：只描述面板该让 owner**理解什么、能做什么**，**不规定任何视觉风格/布局/配色/组件选型**——那是 claude design 的活。实现回来后按项目 design tokens/primitives 落地。

## owner 想解决的问题
单人 AI 学习工具的 mastery 校准是**慢热**的（n=1）：刚开始每个知识点的 θ̂ 都在冷启（不可信），随 owner 持续作答才逐 KC firm up。owner 想**亲眼看着数据变准**——哪些 KC 已经可信、哪些还在冷启、整张图的成熟进度，以及（顺带）哪些 KC 因为没练过而一直是冷启盲区。这是把「数据什么时候更准」从一句抽象解释变成**可观测、可驱动行为**（看到盲区 → 去练它）。

## 数据源（已实现）
`GET /api/observability/calibration-maturity` 返回：
- **per-KC 列表**，每条：
  - `knowledge_id`、`name`（知识点名）
  - `evidence_count`（该 KC 累计作答证据数）
  - `theta_se`（θ̂ 标准误；越小越可信，冷启=1.0）
  - `confidence`（该 KC 题目的平均标定置信度，可能 null=无标定题）
  - `track`（主导标定轨道，可能 null）
  - `cold_start`（布尔：firm ⟺ 有作答 AND evidence≥4 AND precision>1，否则冷启）
- **整图聚合**：`total_kcs`、`cold_start_count`、`firm_count`、`pct_firm`（firm 占比）、`median_theta_se`

## 面板应呈现什么（功能层，非视觉）
1. **整图 firm-up 进度**：一眼看出「整张知识图有多少比例已 firm vs 还冷启」（pct_firm + 计数）——这是「数据整体多准」的概览。
2. **per-KC 成熟度**：能浏览/排序每个 KC 的 evidence / θ̂ SE / cold-start 状态——找出「哪些可信、哪些还嫩」。
3. **冷启盲区**：突出「从没练过（evidence=0）」的 KC——它们是永远冷启的盲区，看到后 owner 可去补练（行为驱动）。
4. **可读的不确定性口径**：θ̂ SE / cold_start 要按 ADR-0035 §24 的「**低置信只信相对排序、不渲染干净的掌握度=78%**」口径呈现——成熟度是「可信/不可信 + 相对位置」，不是精确百分比。这条是**语义约束**（非视觉）：别把冷启 KC 显示成一个看起来精确的数。

## 不在本面板范围
- 不改 mastery 的计算（那是 B1）；本面板纯读、纯展示。
- 不做 KC 编辑/练习触发的写操作（若要「点盲区 KC 去练」的跳转，是后续增量，本期可不含）。

## 边界提醒（给实现者，非 claude design）
- 这是 observability/admin 面（与 logs/cost/jobs 同侧），按既有 admin 面的落地方式接入。
- 动 UI 代码前仍走项目的 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
