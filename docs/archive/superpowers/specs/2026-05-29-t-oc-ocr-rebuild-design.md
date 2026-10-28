# T-OC — OCR/录入 pipeline 重建 Design Spec

> 状态：**design approved 2026-05-29**（brainstorming session）。本 spec 是 [YUK-145](https://linear.app/yukoval-studios/issue/YUK-145) 的实现依据。
> **Build 排期**：post-v1（scenario-B-recut 高优先 track，与北极星 YUK-143 同档）。实施计划 build 时对 fresh main 现场出。
> **Source**：2026-05-29 OCR/图像录入 feature 探查 + brainstorm。依赖 T-D4（propose/write tools，Wave 3 已 ship）—— 无阻塞。

## 1. 问题 / 目的

feature 探查结论：当前录入痛点**不是 OCR 准确性**（腾讯 Mark Agent 结构提取扛得住完形/阅读嵌套），而是 **review 阶段逐块手工**（手填错答/知识点/题型/难度/错因，~2-5min/次，且不随题数摊薄）。另外两个 OCR 解决不好的硬伤：**跨页大题**腾讯搞不定、**题图匹配**靠易错的 bbox 启发式（`assignFigures`）。

目标：把"OCR + 逐块手填"重建为 **AI 主导的结构化→打标→录入 pipeline**，让捕获趋近零手工；呼应"AI 是与用户对等的 first-class actor"（AI 先动、你事后纠）。

## 2. 已锁定的设计决策

| # | 决策 | 来源 |
|---|---|---|
| OC-1 | **腾讯退为纯文字 OCR 底层；VLM 全权拥有结构**。腾讯结构输出降为 hint | 用户"保留腾讯/AI 重建下游" + "保留 VLM 全权修改结构" |
| OC-2 | **StructureTask(VLM mimo-v2.5) 全权重写结构**：跨页大题组装 + 题图匹配 + 布局规范，可完全覆盖腾讯结构 | 用户"跨页大题 OCR 没办法 / 题图匹配麻烦" |
| OC-3 | **泛化捕获**：捕获所有，outcome 是 signal（对=掌握正信号、错=错题、无作答=题/材料），**不**写死 mistake。下游是泛化 `EnrollTask`（非 MistakeEnrollTask）| 用户"录入所有，做对也是 signal，题目看法泛化" |
| OC-4 | **高置信自动入库 + 低置信 review**：WorkflowJudge 裁决，高置信直接入库（可改），低置信/歧义 → review | 用户"高置信自动导入 + 低置信才 review" |
| OC-5 | **evidence-first 安全垫**：自动入库落 event + AI provenance + 可改；"AI 自动录了 N 条"复查面；阈值可调 | 项目原则 + 自动入库风险缓解 |

## 3. Pipeline + 组件

```
照片(1-N页) → 腾讯 OCR(文字) → StructureTask(VLM 全权结构)
            → TaggingTask → EnrollTask(泛化) → WorkflowJudge
            → 高置信: 自动入库(可改)   /   低置信: review 队列(AI 预填)
```

| 组件 | 职责 | 复用/新建 |
|---|---|---|
| **腾讯 OCR**（保留）| 字符级文字提取（准）。结构输出降为 hint | 现有 `tencent_ocr_extract` 改造：只取文字层 |
| **StructureTask**（VLM 全权，OC-2）| 输入 图(N页) + 腾讯文字 hint → 规范结构树；**全权重写**；跨页大题组装；题图匹配（VLM 看图判图属哪题，替 `assignFigures`）| 新 AI task（多模态 mimo-v2.5）；吸收现有 vision rescue |
| **TaggingTask** | 自动打 knowledge_ids（knowledge_hint + 知识网格 + 题面语义）| 新 AI task；复用 DomainTool 网格读 |
| **EnrollTask**（泛化，OC-3）| 落 generalized LearningRecord；有作答→AI judge → outcome signal（对/错/部分）；草拟 答案/题型/难度/错因(若错)| 新 AI task；取代写死 `attempt(outcome=failure)` 的 import |
| **WorkflowJudge**（OC-4）| 多 agent/单 pass 置信裁决 → route 自动入库 vs review | 新 AI task（置信闸门）|

## 4. 泛化捕获模型（OC-3，本设计的一个 model 升级）

**修正现有硬伤**：当前 `app/api/ingestion/[id]/import` 写死 `attempt(outcome=failure)` + learning_record，把每次 OCR 录入都当错题。

新模型：捕获 → 若图中有手写/可见作答，AI judge 它 → **outcome 是 signal**：
- **对** → 正向掌握 evidence（喂 FSRS/mastery，是好事——做对也是进度）
- **错** → 错题信号（走现有 attribution→variant 链）
- **无作答** → 题/材料（入题库 / 待练习；错题等真做错时自然产生）

统一落 generalized `LearningRecord`（呼应 `/record` 已有的泛化录入：错题/例题/疑问/顿悟/反思/资源）。这不止服务 OCR——它把"录入=错题"的隐含假设泛化掉。

## 5. 安全垫（OC-5，evidence-first）

- 自动入库项：`event` 落 AI provenance（`generated_by`），可改、可回滚。
- **"AI 自动录入了这些 (N)" 复查面**：用户能一眼看到 AI 自动录了什么、快速纠错（类似 Living Note 的 AI-changes panel）。
- WorkflowJudge 置信阈值：config flag 可调（保守起步：阈值偏高，多走 review；用熟了再放开）。
- 低置信 → 现有 review UI（AI 预填，用户确认/改）。

## 6. 与现有的接缝

- **复用**：ingestion `learning_session` + `question_block` + R2 assets + SSE 进度 + `source_asset`。
- **取代**：review 阶段逐块手填；`assignFigures` 启发式题图匹配（→ VLM）；单页限制（→ VLM 跨页，吸收 [YUK-144](https://linear.app/yukoval-studios/issue/YUK-144)）；写死 mistake 的 import（→ 泛化 EnrollTask）。
- **吸收 cheap win**：knowledge_hint 预选 → 并入 TaggingTask。
- **AI 集成**：复用 DomainTool registry（T-D4 已 ship）+ runner + provider（mimo-v2.5 多模态）。

## 7. Open questions（spec→build 时定）

1. WorkflowJudge 置信阈值的初值 + 是单 pass 还是多 agent 投票（单用户可能单 pass 够，YAGNI 评估）。
2. "做对的作答"喂 FSRS/mastery 的语义：算一次 review success（推进 FSRS schedule）？还是仅初始 mastery evidence？—— 触及 ADR-0012 mastery 派生 + FSRS state，需小心。
3. VLM 跨页 / 多图的 token 成本（多页大题 = 大 prompt）；是否分页 OCR + VLM 再组装 vs 整批喂。
4. StructureTask 全权重写后，与腾讯 hint 的冲突解决（VLM 赢，但保留腾讯 bbox 供 figure crop？）。
5. 题图匹配：VLM 输出图↔题关联 → 仍用腾讯/sharp 做 crop，还是 VLM 给 bbox。

## 8. 边界 / 非目标（YAGNI）

- 不替换腾讯的字符 OCR（它准，VLM 只接管结构/语义层）。
- 不做实时协同 / 多用户。
- WorkflowJudge 不过度多 agent（单用户起步可单 pass + 置信分）。

## 9. 验收（实现时细化）

- 多页大题照片 → VLM 跨页组装成单题（YUK-144 多页根治）。
- 题图自动正确关联（VLM，替启发式）。
- 高置信块自动入库（落 LearningRecord + outcome signal + AI provenance event），低置信进 review（AI 预填）。
- 做对的作答 → 正向 signal（不当错题）；做错 → 错题链；无作答 → 题/材料。
- "AI 自动录入 N 条"复查面可纠错。
- 回归：现有 ingestion session / R2 / SSE 不破。

## 10. 关联

- Linear：[YUK-145](https://linear.app/yukoval-studios/issue/YUK-145)（15pt，post-v1 高优先）。吸收 [YUK-144](https://linear.app/yukoval-studios/issue/YUK-144)（多页 bug）+ knowledge_hint cheap win。
- 依赖 T-D4（Wave 3 已 ship）—— 无阻塞（修正 roadmap stale 假设）。
- 触及 ADR-0002（structured-extraction vs LLM，需 revision：VLM 全权结构是对 0002 的演进）+ ADR-0012（mastery，OC-3 正向 signal）。实现需 ADR revision/new。
- 闭合：当前 import 写死 mistake 的泛化（OC-3）。
- Closeout 时补进 master-roadmap §2.6 + §11（T-OC 从"⬜ 待建/砍-able"提为已设计高优先）。
