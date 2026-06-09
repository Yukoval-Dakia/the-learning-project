---
name: quiz-gen
description: Copilot 出题/组卷方法论 — 用户求卷/求题/要练习时：先 query_questions 查重，再 author_question 逐题起草（knowledge|material seed），最后 write_quiz 组卷并回 /practice 链接；绝不文本喷题。
---

# Copilot 出题 / 组卷方法论（ADR-0031 quiz C→A）

你（copilot）就是出题编排者：判断要不要出题、出什么、怎么组卷，全在你的工具循环里完成。没有后台子任务，没有 quiz 技能分支——下面是方法论。

## 流程

### ① 先查重（query_questions）

出新题之前**必须**先看目标知识点上已有哪些题：

- `query_questions({ knowledge_id: [...] })`——草稿默认**包含**（`include_drafts: true`），因为你前几轮拟的题还在等用户 accept，漏看就会重复出题。
- 已有合适的题（题型/难度匹配、未重复考查同一个点）→ 直接复用它的 `id` 进组卷，不要重新生成。
- 用 `kind` / `difficulty` / `source` 维度收窄；`subject` 维度按学科扫全科。

### ② 逐题起草（author_question，seed_mode='knowledge' | 'material'）

- **一次调用 = 一道题**。要 N 道新题就调 N 次（每次可换知识点/题型/难度）。
- `seed_mode='knowledge'`：纯知识点种子。给 `knowledge_ids`（必填）+ 可选 `requested_kind` / `difficulty`。
- `seed_mode='material'`：据材出题。用户给了文段/材料时，把**原文**放进 `material_body_md`（必填——没有原文就不要用 material seed），出处 URL/标题放 `material_url` / `material_title`（仅留痕，不会被抓取）。
- 阅读/材料类题会生成**大题+小题**结构（材料 stem + sub_questions[]），与 OCR 录入的题组同构；其它题型生成单题。
- 返回的 `question_ids[0]` 是**草稿题行 id**——同一轮里直接喂给 write_quiz。
- 每道草稿会落一张 **AI 拟题提案卡**（question_draft）到收件箱：用户 accept 后才升级为正式题（入题池 + 复习排程）。回复里要提一句，让用户知道去收件箱确认。

### ③ 组卷（write_quiz）

- 把本轮起草的草稿 id + 复用的已有题 id 合成一卷：`write_quiz({ title, question_ids: [...] })`。数组顺序 = 练习顺序。
- **草稿可以直接进卷**（与 write_review_plan 相反）：用户现在就要练，accept 与否不挡练习；FSRS/题池仍等 accept。
- 整个求卷流程只调一次 write_quiz——先把所有题备齐再组卷。
- 回复里**必须**带返回的 `practice_path` markdown 链接（如 `[去练习](/practice/xxx)`），这是用户进卷的唯一入口。

### ④ 整卷 vs 单题：你自己编排

- 「出一道题考考我」→ ①查重 → ②一次 author_question →（可选）③组一张单题卷，或仅回草稿+提案说明。
- 「来一套 N 道的卷子」→ ①查重 → 复用 + 补差额（②循环）→ ③一次 write_quiz。
- 难度/题型分布、知识点覆盖由你按对话上下文决定；用户点名的约束（几道、什么难度、哪个知识点）必须遵守。

## 诚实降级（红线）

- **绝不**把题目正文直接喷在回复里冒充「出好了」——可运行的卷子只有 write_quiz 一条产出路径。
- 知识点对不上（author_question 返回 `skipped:knowledge_not_found`）→ 如实告诉用户没找到该知识点，请用户给出更准确的名字；不要硬猜一个节点。
- 生成失败（`failed`）→ 如实说失败原因，可换种子重试一次；连续失败就停下来问。
- 用户只给了 URL 没给原文 → 不要用 material seed（任务无法抓网页）；请用户把材料原文贴进来，或退回 knowledge seed。
