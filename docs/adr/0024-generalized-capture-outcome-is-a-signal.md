# ADR-0024: 泛化捕获 — 录入的 outcome 是 signal，不写死 mistake

**Status:** Accepted
**Date:** 2026-05-30 (T-OC slice 1 / YUK-145)
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0002（structured-extraction → VLM-owns-structure 方向修订，2026-05-30）/ ADR-0006 v2（events 是真相）/ ADR-0008（learning_session 多类型信封）/ ADR-0012（mastery as derived view — 本 ADR 触及其 FSRS/mastery 语义）/ ADR-0014（generalized activity & capability registry）/ ADR-0015（learning_record）

## Context

T-OC OCR/录入 pipeline 重建 design（`docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md`，OC-3）暴露一个 model 层硬伤：

`app/api/ingestion/[id]/import` 对**每一个**导入块都写死：
- `event(action='attempt', outcome='failure')`，以及
- `learning_record(kind='mistake')`。

即录入模型隐含假设 **「捕获 == 错题」**。这对一张照片里**做对**的题是错的——做对是正向掌握 evidence（进度），不是错题；对**没作答**的题也是错的——那是题/材料（题库 / 待练习），不是错题。

这个假设不止影响 OCR：它把"录入 = 错题"焊死在唯一的批量录入路径上。`/api/records` 早就有泛化录入（mistake / worked_example / open_question / insight / reflection / observation / resource_note），但 ingestion import 没接上。

## 决策

**录入的 outcome 是 signal，不写死 mistake。** ingestion import 把每个捕获块按 outcome 信号泛化路由到统一的 `LearningRecord`：

| outcome 信号 | attempt event | LearningRecord.kind | 下游 |
|---|---|---|---|
| `failure`（做错） | `attempt(outcome='failure')` | `mistake` | 现有 attribution→variant 链（不变） |
| `success`（做对） | `attempt(outcome='success')` | `worked_example` | 正向掌握 evidence（喂 `knowledge_mastery` view） |
| `partial`（部分对） | `attempt(outcome='partial')` | `worked_example` | 同上，部分信号 |
| `unanswered`（无作答） | **无** attempt event | `open_question` | 题库 / 待练习；真做错时再自然产生 mistake |

落地为 `src/server/ingestion/enroll.ts::enrollCapturedBlock`。import route 不再 inline 写死 failure，改为按块 delegate。`outcome` 是 import wire 上的**可选**字段，**默认 `'failure'`** —— 现有 review UI（VisionTab）行为字节级不变；新值由后续 slice（WorkflowJudge）或 review UI 提供。

为什么能这么小：
- `AttemptOnQuestion`（`src/core/schema/event/known.ts`）**本来**就允许 `outcome ∈ {success, failure, partial}`。不需要改 event schema。
- `LearningRecordKind` 本来就有 `worked_example` / `open_question`。不需要改 enum。
- 不引入任何新业务 column（`pnpm audit:schema` 不受影响）。

## ADR-0012 正向 signal 语义（本 ADR 的关键 care point）

**做对的捕获 = 初始 mastery evidence，不是合成 FSRS review。**

- 写 `attempt(outcome='success')` → 自动喂 `knowledge_mastery` 派生 view（ADR-0012 mastery 聚合 `event WHERE action IN ('attempt','review')`，attempt success 正是它已经在聚合的那类证据）。**零新写路径。**
- **不**写 `review` 事件 → **不**推进 FSRS schedule。

理由（保守、低风险）：
- FSRS schedule 推进要求一个真实的 `ReviewOnQuestion`，它携带 `fsrs_state_after`（ts-fsrs Card dump）+ `fsrs_rating`。从一次 OCR 捕获合成 review 等于**凭空捏造 FSRS state**，没有真实的回忆信号 —— 高风险，明确划出 slice 1 范围。
- 捕获的题仍然是一行 `question`，会正常进复习队列；它的**第一次真实复习**那时才推进 FSRS。
- 与 ADR-0012 "mastery 不是状态，是派生摘要" 完全一致：attempt success 进 view，不进任何 stored FSRS 列。

## Evidence-first（OC-5）

每个 enroll 出的 item 的 event payload 携带 provenance marker
`{ generated_by: 'ingestion_capture', enroll_outcome: <signal> }`，可追溯可回滚。
slice 1 的捕获是用户 review 过的（review UI 送块），故 `generated_by='ingestion_capture'`。
slice 3 的 WorkflowJudge 高置信自动入库时会把它设成 `'workflow_judge'` 并驱动
"AI 自动录入 N 条" 复查面。这个 marker 就是 slice-3 的接缝（代码里有注释指向 lane plan）。

## 接受的代价 / 边界

- slice 1 的 `outcome` 信号来自 wire（review UI / 后续 WorkflowJudge）。slice 1 **不**自己跑 AI 判对错——那是 slice 3 WorkflowJudge 的事。默认 `failure` 保证旧行为不破。
- `unanswered` 块不产生 attempt event，因此不进 `getFailureAttempts` 错题视图（符合预期：它是题/材料，不是错题）。
- `mistake_ids` wire 字段语义进一步泛化（已是 opaque token）：failure/success/partial 走 attempt event id，unanswered 没有 attempt event 时回落到 record id。

## 触发重新评估

- slice 3 WorkflowJudge 落地 → `generated_by` marker 由 stub 变实装，本 ADR 的 provenance 节转"已实装"。
- 若未来要让"做对的捕获"也推进 FSRS（例如视为一次轻量自测）→ 那时新增一个真实 review 写路径并在此 ADR 记修订，**不**回退到合成 review。

## 一句话总结

> 捕获不是错题——outcome 是 signal：做对喂 mastery（不推 FSRS）、做错走错题链、没作答进题库。

> **M5 路径注（YUK-321，2026-06-13）**：本文提及的 `app/api/**` Next route 路径已随旧栈拆除迁移至 capability manifests（`src/capabilities/*/manifest.ts` + 各包 `api/*.ts`），由组合根 `server/app.ts` 挂载；决策本身不受影响。
