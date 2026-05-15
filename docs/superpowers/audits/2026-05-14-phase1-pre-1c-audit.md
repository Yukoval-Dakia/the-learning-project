# Phase 1 Pre-1c 审查

**Date**: 2026-05-14
**Branch**: sub-0c-implementation
**Scope**: 全部 plans / specs / code / ADRs / CONTEXT.md，从"通用学习框架"愿景视角

## TL;DR（三句话）

1. **plan / spec / code 三轴罕见地对齐**——后端秩序极好（16 plans，14 specs，13 落地，Sub 0c 进行中，Sub 0d 待启）。
2. **UI 完全为 0**。`app/page.tsx` 是 "Stack migration in progress" 占位；`src/ui/` 空目录。所有功能 API 可达，**无任何人类入口**。
3. **五个核心抽象（mistake / question / subject / FSRS / OCR）都暗中假设"做错题→做对"范式**，与"通用学习框架"愿景有结构性张力。

---

## A. 冲突（具体矛盾）

| # | 冲突 | 解决路径 |
|---|---|---|
| 1 | CONTEXT.md 状态机（2026-05-14 更新含 `queued/extracting/partial`）vs `IngestionSessionStatus` enum 缺这 3 值 | Sub 0c Step 0.4（已纳入补丁） |
| 2 | ADR-0002（auto-cascade 删除）vs `src/server/ingestion/cascade.ts` 仍是四层 waterfall | Sub 0c Step 10 删 cascade.ts |
| 3 | ADR-0004（`agent_sessions` 表）vs schema 中无相关表 | Sub 0d 待启 |
| 4 | `QuestionBlockStatus` enum 含 `'merged'` 但全仓零写入；Sub 1b plan 称之为 client-side transient，但 UI 不存在所以连 client 都没生 | 可在 Sub 0c 顺手砍（与 `'reviewed'` 一并） |
| 5 | CLAUDE.md 与 `app/api/_/seed/route.ts` 存在但无 plan/spec 提及 | 加一行 docstring |

---

## B. 漏洞（提了但没人做）

**结构性（高 severity）**：

1. **没有任何 UI plan**。Sub 0b 名字带"UI lands in Sub 0b"但只做了 API 迁移；Sub 0a → 0d 全是后端整理。**项目目前在"后端完备但无人触达"状态**。
2. **`artifact` 表零调用**。CompletionEvidence / outline_json / tool_state / sections / history 全建了 schema 和 Zod 类型，连 admin 端点都没碰过。**占用 agent context + schema 复杂度但零产出**。
3. **多 subject 切换路径**。`'wenyan'` 硬编码 4+ 处（seed.ts / proposals.ts / registry prompt / curriculum.json）；schema 无 `subject_id` 列；**没有切换机制**。
4. **ADR-0004 承诺的 4 个 task 未建**。`JudgeMistakeTask` / `VariantGenTask` / `DreamingTask` / `MaintenanceProposeTask` —— ADR 列表 60% 的格子是空的。

**操作性（中 severity）**：

5. **`mistake.cause` 用了但用户看不见**。被 AttributionTask 写入、被 KnowledgeReviewTask 读、被 CSV 导出——但因为没 UI，**归因结果今天等于内部 metadata**。
6. **dreaming/maintenance cron 还没起跑**。`dreaming_proposal` 表被写入，但调度器（pg-boss cron）在 Sub 0c Step 5 才上线。**当前 proposals 是只入不出的**。
7. **`session summary`**（CONTEXT.md 提及）零代码痕迹。
8. **agent 破坏性操作的"必须 propose"约束是文档而非代码**。没有 lint / type-level enforcement。

---

## C. "通用学习框架"维度诊断

把目标展开成可操作的诊断轴，看当前架构暗中假设了什么：

| 维度 | 当前假设 | 通用框架需要 | 张力 |
|---|---|---|---|
| 学习 → 行为 | "错题驱动" —— 你做了一道题，错了，才进入系统 | 阅读、听讲、对话、创作、free play 都算学习 | **mistake 是 first-class entity** 这件事本身就过窄 |
| 内容 → 单位 | 离散问答（prompt + answer + cause） | 长文连续阅读、技能练习、项目工作没有"题" | question/mistake 是骨架，**没有"暴露 (exposure)"或"活动 (activity)"** |
| 输入 → 模态 | 拍纸质卷子（Tencent OCR） | 图 / PDF / 音频 / 视频 / 剪贴板 / 聊天记录 / 文件 | **OCR cascade 的范式只适合纸质作业** |
| 调度 → 算法 | FSRS 间隔重复 | 技能 = 交错练习；项目 = 截止日；探索 = pull-driven；理解 = 深度而非重复 | **FSRS 是 fsrs.ts 里唯一存在的策略** |
| 知识 → 拓扑 | 单层级树（knowledge.parent_id） | concept × skill × meta × cross-subject 关系图 | **flat tree 无法承载跨学科 / 技能-概念分离** |
| AI → 角色 | 分析师（Backend Purpose）+ 助理（Copilot） | 导师（解释）/ 教练（激励）/ 同伴（探索） | ADR-0004 只列了两类，**没有"AI 与你共同学习"的形态** |
| 学习者 → 意图 | 隐式（错题来了就 review） | 显式 goal → plan → progress trail | **没有"为什么学"的语义层** |
| 触达 → 摩擦 | evidence-first → 重 → 拍照 + 上传 + 等抽取 + 审阅 + 导入 | 数字原住民要"看了一行想记 → 一次点击就进库" | **入库流水线 6 步，1 步都不能省的设计** |

---

## D. 三档建议

### 🔴 必修

1. **写一份 Phase 1c plan**——含 UI + 概念抽象探索（见 brainstorm doc）。
2. Sub 0c 收尾时 grep verify `'wenyan'` 硬编码点全部留 `// TODO: multi-subject` 标记。

### 🟡 该修

3. 删 `artifact` 表 + 相关 schema，**或**补一份 plan 用起来。今天它是 schema 噪音 + agent context 浪费。
4. `merged` enum 顺手砍（已无写入者）。
5. 决定 `Judge` / `VariantGen` / `Dreaming` / `MaintenanceProposeTask` 四个任务命运：要么落地（每个一份 plan），要么从 ADR-0004 表里删掉。
6. `/api/_/seed` 加 docstring。

### 🟢 可推翻（重点 brainstorm 方向）

7. **`encounter` 抽象化 `mistake`**——越早做越便宜。详见 brainstorm。
8. **`learning_session` 作为通用 envelope**——与 7 配套。
9. **多模态 ingestion**——OCR cascade 是历史包袱。
10. **goal / plan / progress trail**——从"工具"到"框架"的关键。

---

## E. 一句话主张

"通用学习框架" 与当前架构的最大裂缝不是技术，是**基本概念**：`mistake` 太具体、`question` 太规整、`subject` 太教科书、`FSRS` 太单调、`OCR` 太纸质。

这些都源自一个未明说的假设——"学习就是把做错的题做对"。

如果你真要做"通用学习框架"，**R1（encounter）+ R5（session envelope）是地基**。剩下的（多模态 / 多调度器 / goal trail）都靠这俩支撑。

详见 `docs/superpowers/brainstorms/2026-05-14-phase1c-encounter-session-ui.md`。
