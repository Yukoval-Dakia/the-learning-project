---
status: accepted
---

# ADR-0078 — 备题员直接切换：一位备题员是题目唯一入口

**Status:** Accepted（owner 2026-11-04 决定：废掉 ADR-0069，直接切到备题员）。
**Supersedes:** ADR-0069（其保留条款已并入本文；冲突处以本文与 YUK-1468 的 2026-11-04 Owner 决定为准）。
**Decision source:** YUK-1468 顶部「2026-11-04 Owner 决定」；协调线补充（2026-11-04，`tlp-docs/audit/2026-11-04-flexible-grading-and-presentation-review.md`）。
**Tracking:** [YUK-1468](https://linear.app/yukoval-studios/issue/YUK-1468)。
**Related:** ADR-0072（题库三工具，工具部分继续有效）、ADR-0073（判分系统）、ADR-0074（作答与展示）、ADR-0067（教研白板）、ADR-0068（通用学科——jyeoo 覆盖诚实声明）、YUK-1771（解法先验，迁移线接入同一准入路径）、YUK-1548 v2 §19（对话出题走同一入口）、YUK-1791（授权后继被用途闸拦下，影响准入存量）。切换计划真相源（仓库外，versioned）：`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-04-yuk1468-cutover-plan.md`。

## 决定

### D1 备题员 = 题目唯一实际入口；工具面 = 找题工具 + `edit_question` + `compose_presentation` + `submit_question`

供题教研员（备题员）是纯后台 agent。它接收 typed 缺口单（GapTicket：考什么知识 / 错法定向、难度带、用途、数量与时限），自己决定去哪找题。**Owner 文本中的 `store_sourced_question` 已由 `submit_question` 接管——凡 owner 决定写 `store_sourced_question` 处，真实 seam 就是 `submit_question`。** 工具面：

- 找题与证据：`search_bank` / `read_bank` / `check_bank`（ADR-0072，有效）、知识图谱读取（`query_knowledge` / `get_subject_graph_overview` / `expand_knowledge_subgraph` / `find_knowledge_paths`）、`query_mistakes`（错法定向缺口的证据面）、`scan_coverage_gaps`（见 D2）。
- 外部取水核心（留作工具，不含路由）：`web_fetch_candidates`、`jyeoo_fetch_candidates`。
- 产出与入库：`edit_question`（建/修 v2 草稿文档）、`compose_presentation`（展示积木/沙箱）、`compose_block`（generative-UI 积木，v2 §14.3）、`submit_question`（唯一入库闸）。

`author_question` 工具名暂留给交互式 Copilot 拟题，后端改为 `edit_question`/`submit_question` 草稿链与 v2 §19 `teaching_draft` seed（服务端确定性组文档，无嵌套出题 task）——它不再派发 `QuestionAuthorTask`；`generate_question_candidate` 一并删除（它只是 `QuestionAuthorTask` 的薄壳）。备题员自出直接写草稿文档，不经第二个出题任务。

### D2 缺口单来源 = Coach、低库存信号、手工；`question_supply_nightly` 降为确定性读工具

缺口单（GapTicket）来自 Coach、低库存信号与手工请求——不再有自动派发的需求层。`question_supply_nightly` 的调度派发腿删除；其确定性覆盖缺口扫描（`discoverSupplyTargets`）改为 **read 工具** `scan_coverage_gaps`，作为信号面给 Coach 与备题员，effect='read'、零 LLM、零写。`supply_planner` / `supply_execute` 的规划与路由逻辑整体取消；取水核心（web、菁优）留作 D1 工具。refill（默认关）并入备题员，走统一费用策略。

### D3 顺序与形式全交 agent，只看质量；QuizGenTask / QuestionAuthorTask 随切换退役；篇/小问能力保留

找题顺序完全交给备题员，纯按质量取舍（不设默认顺序，同 ADR-0069 D3）。**题型/形式不再提前定死**：备题员提示词描述能力——契约原语（structure/response_spec/scoring_basis/execution）、展示积木与沙箱（compose_presentation、blocks-v1、sandbox-v1）、给分规则语言——由 agent 按「怎样最能考查」选形式，不按固定题型清单。`QuizGenTask` 与 `QuestionAuthorTask`（含 plan-then-gen 及 quiz_gen_plan）随切换退役；**篇（passage）+ 小问（sub-question）结构能力必须迁入新路径**——v2 草稿文档的 `parts[]/units[]/materials[]` 已承载（多 part、多作答位、共享材料），退役的是产出管线不是结构能力。元数据标注（知识点、难度、解法标注等）归备题员；YUK-1771 的入库解法先验由迁移线继续做，接入同一准入路径，本线不改写其写集。

### D4 同一道准入门，不分来源；检查 job 只留 `question_admission_run`

不管候选来自 jyeoo、web、自出、改编还是本人材料，都过同一道准入——`question_admission_run`（G1 双盲独立求解 + G2 逐单元标定 + YUK-1771 解法先验）是唯一付费独立求解后端；入库题 100% 过自动判分准入（YUK-1445 口径）。`QuizVerifyTask`/`quiz_verify` 与 `source_verify` 的独立求解与准入重复 → 删除。`variant_verify` 与其把变式打回 `broken` 的写路径 → 删除。**确定性检查（结构、题面、图、去重、n-gram、来源一致性）同步进 `submit_question`，不过就返回 typed issues 给 agent 修**，不再异步发现。落地时若某检查抓到准入抓不到的真实问题，迁进准入或入库闸——不留第二条链。

### D5 金标两级：admitted 自动、gold 仅 owner 亲手认证；agent 永不自盖

准入实测通过自动标 admitted；`gold` 只能由 owner 亲手认证（metadata 存储）。agent 永远不能给自己出的题盖金标。出题时按标签+语义检索 2–3 道金标作参考，改编产物 provenance 记 `adapted_from:<id>`。

### D6 唯一入库闸 `submit_question`；不另造写入器

`submit_question` 的 draft path（`draft_ref` → 契约四层 → `publishQuestionGroup` 单一发布 seam）与 candidate path（jyeoo_fetch / sourcing_web 候选，原 store_sourced_question 语义）是全来源唯一闸：provenance 覆盖 `generated / adapted / owner_material / photo_ingest / jyeoo_fetch / sourcing_web / manual`（`DraftSourceKind`，非 fetch 来源用可复现内容指纹，绝不伪造 extraction_hash）。KC 活体校验、foreign-host、exact/near/source-URL/向量去重对所有来源一致；新知识点只作提议不自动批准；student 作答走既有 attempt writer，不经本闸。**无人工启用步**：任何来源过 `submit_question` → 准入，过即自动可练——「核验并启用」与「不核验，直接启用」两个人工面随 `verify-and-promote` 一并删除；准入失败时页面如实显示原因，学习者可修可修项。

### D7 付费效果硬边界与承重保护

不删 handler 丢弃未知付费效果；不重跑生成来补验证。`docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md` §9 的 8 项 pre-AI 承重能力全部不动。费用走**统一供给成本政策**（YUK-1744，#2437 spend gate）：备题员无单独上限、也无豁免，花费全量记账。jyeoo 的 40/日硬闸与预算租约是外部授权约束，独立保留；jyeoo 覆盖诚实声明（ADR-0068 D7：只覆盖高中 10–12 数学）。

## 取消项（相对 ADR-0069）

- 旧 D6 与修订第 5 点的「并跑数周 + 盲核对比 + 等 owner 同意」——不搭并跑设施；验收证据见「验收」节，没变差就切。
- D2 夜间扫描安全网的调度派发（扫描保留为 D2 读工具）。
- `supply_planner` / `supply_execute` 的规划与路由层；`route-planner` 约束序、`dispatcher` 自动派发。
- `quiz_verify` / `source_verify` / `variant_verify` 三个检查 job（per-check 处置表见切换计划 §检查处置）；`TeachingQualityTask`（quiz_verify 删除后无消费者）与 `generate_question_candidate`（QuestionAuthorTask 薄壳）随删。
- 「核验并启用」「不核验，直接启用」两个人工启用面与 `verify-and-promote`（S4，YUK-1789）：准入即启用，无人工步。
- 旧 `kind` / `judge_kind_override` / `answer_class` / `rubric_json` 生成字段随 QuizGen/QuestionAuthor 退役停写；存量读取另行清理。

## 验收（切换证据）

- 三张真实缺口单（零覆盖知识点、错法定向、难度带定向）跑通备题员，查库、外找、自出各至少一次，并做一次同缺口新旧路径对照，结果进回执；没有变差就切。
- 备题员用真实模型产出至少：一道断句或配对题、一道排序题、一道沙箱交互题、一道非默认给分规则题——全部过准入，并在真实页面上作答与判分（TEST 基线：这四类在 436 组中均为 0）。另加一道依赖模型自绘图的题：图必须随题到达 solver（v2 §14.4）。
- **依赖：** AI 判分切片启用（`model_slice_admission_run`，311 组卡 human_review）由协调线另票处理，不在本线；非 deterministic 判分单元的准入依赖它。

## 硬边界（后果）

1. **零新入口**：工具面之外不新增 agent tool 面、学习者可见面、第二 commit seam 或第二事件总线。
2. **`submit_question` 是唯一入库闸**；入库题 100% 过 `question_admission_run` 准入。
3. **agent 永不自盖金标**。
4. **失败如实写回**（差什么、为什么不硬凑）；不降低门的代价换交付；无进展终止兜空转。
5. **花费统一成本政策**：全量记账；备题员无单独上限、不豁免 YUK-1744/#2437 供给 spend gate；canary/费用事件规则保留。
6. **付费效果硬边界**（见 D7）；在途旧任务（排队/运行/重试/DLQ/placement claim）先排空再删旧路径。
7. **§9 八项承重不动**。
8. **无 AI-reviews-AI 隐藏闸**：不做预设类别、不做防御性特殊政策、不做隐藏/截断的 AI 审 AI。
