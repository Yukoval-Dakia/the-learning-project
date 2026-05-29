# ADR-0026 — WorkflowJudge 置信闸门 + flag-gated 保守自动入库（OC-4 / OC-5）

**状态**：accepted
**日期**：2026-05-30 (T-OC slice 3 / YUK-145)
**Supersedes**：—
**Superseded by**：—
**Related**：ADR-0024（泛化捕获 — outcome 是 signal；本 ADR 复用其 `enrollCapturedBlock` 作为唯一入库 owner）/ ADR-0012（mastery as derived view）/ ADR-0014（generalized activity & capability registry）/ ADR-0002（VLM-owns-structure 方向，slice 2 已实装）

> 起源：T-OC OCR/录入 pipeline 重建 design
> （`docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md`，OC-4 / OC-5）+
> slice-3 lane plan `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md`。
> 本 ADR 固化 slice 3 的两个决策：(1) Tagging/Judge 置信闸门的形态；(2)
> flag-gated 保守自动入库 rollout。UI 复查面（OC-5）DEFERRED 到 slice 3b，不在此。

## Context

OC-4 要把"OCR + 逐块手填"推进到 **AI 主导**：高置信块自动入库（AI 选知识点 +
outcome），低置信/歧义块落现有人工 review。OC-5 要求自动入库是 evidence-first：
每条落 `event` 带 AI provenance、可追溯可回滚，且**保守起步**（阈值偏高、默认多走
review）。

两个开放问题（spec §7）要在 build 时定：
1. WorkflowJudge 是单 pass 还是多 agent 投票？
2. AI 建议要不要持久化到 `question_block`？

## 决策

### 1. TaggingTask = 单次结构化输出 AI task（非多模态）

新 AI task `TaggingTask`（registry + task-prompts builder）：输入 = 抽取出的**题面文字**
（由 `question_block.structured` 经 `structuredToPromptMarkdown` 派生）+ 可选
`knowledge_hint` + 一份知识网格快照（节点 + mesh 边，复用 `knowledge` /
`knowledge_edge` 读，bounded ≤200 节点）→ 输出 = `{ suggestions:
[{ knowledge_id, confidence, reasoning }], overall_confidence, reasoning }`。

- 非多模态：题面已是文字（slice 2 VLM 已把图变结构），打标只需文字推理 →
  `mimo-v2.5`、`needsToolCall:false`、`maxIterations:1`、`allowedTools:[]`。
- **反幻觉双保险**：prompt 禁止发明网格外节点；invoker
  (`src/server/ingestion/tagging.ts`) 再过滤掉任何不在 grid 里的 `knowledge_id`。
- 形态对齐既有单次结构化 task（GoalScopeTask / SemanticJudgeTask）：strict JSON +
  Zod 校验。

### 2. WorkflowJudge = 确定性单 pass 聚合器，**不是**第二个 LLM（spec §7 Q1，YAGNI）

单用户场景，多 agent 投票是过度工程。WorkflowJudge
(`src/server/ingestion/workflow-judge.ts`) 是一个**纯函数**：

```
combined = min(extraction_confidence, tagging.overall_confidence)   // 最弱环节
route = (combined >= threshold AND suggestions.length > 0) ? 'auto' : 'review'
```

- **最弱环节闸门**：结构置信 OR 打标置信任一拉胯都强制走人工 review。保守。
- 输出 `{ route, confidence, prefilled: { knowledge_ids, outcome, difficulty,
  question_kind } }`。
- `prefilled.outcome` 恒为 `'unanswered'`（题/材料）—— 最安全的信号：捕获的题没有
  judged 作答时是题库，**绝不**凭空合成 attempt。给手写作答判对错（→ success/
  partial/failure）是独立的 EnrollTask（spec §3），slice 3 不做。
- 零 LLM 调用、零新 provider 成本。

### 3. flag-gated 保守自动入库（OC-5 关键安全垫）

`src/server/ingestion/workflow-judge-config.ts`：

- `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` env flag，**默认 OFF**。判定：**仅**当显式等于
  字符串 `'true'`（大小写不敏感）才 ON；undefined / '' / 'false' / 其它一律 OFF。
- 这是 `WAVE6_TRIGGER_*_ENABLED`（默认 ON、opt-out）约定的**反向**：自动入库是替用户
  写持久学习数据，必须 opt-IN、不可错过地默认 OFF。
- `WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD` 默认 `0.85`（高门槛 → 多走 review），可调。

自动入库路径 `src/server/ingestion/auto-enroll.ts::runAutoEnrollForSession`：
flag OFF（默认）→ 在任何 tagging/judge/enroll **之前**短路返回 no-op。**默认下零
自动入库，每块都走现有人工 review，production 行为与今天字节级等价。** flag ON 时
对每个 `status='draft'` 块跑 TaggingTask → WorkflowJudge；route 'auto' 的块在一个
事务里 INSERT `question` + 调 `enrollCapturedBlock(tx, { ...,
generatedBy:'workflow_judge' })` + 把 `question_block` 翻 'imported'；route
'review' 的块**原封不动**留 'draft' 给人工流（无行为变更）。

### 4. evidence-first：复用 `enrollCapturedBlock`，不加侧表（spec §7 Q2 的答案）

自动入库走 **ADR-0024 的同一个入库 owner** `enrollCapturedBlock`，唯一区别是
event payload 里 `generated_by='workflow_judge'`（vs 人工的 `'ingestion_capture'`）。
这个 event 就是可追溯可回滚的耐久审计记录。

**不**给 `question_block` 加 `ai_suggested_knowledge_ids` / `ai_judge_confidence` /
`ai_judge_payload` 列：持久化 AI 建议只有 DEFERRED 的复查面 UI（要在用户动手前展示
prefill）才需要。自动入库路径在内存里消费 Tagging/Judge 输出即可。结果：
**`pnpm audit:schema` 零新 allowlist 条目**。复查面 UI 落地（slice 3b）时再按需加列 +
自带写路径。

## 接受的代价 / 边界

- WorkflowJudge 确定性聚合不"理解"题目对错，只聚合两个置信分。够单用户保守起步；
  要更聪明的 route 再升级（那时记修订）。
- `prefilled.outcome='unanswered'` 让自动入库的块只进题库、不产 attempt/mistake。
  符合预期：没 judged 作答就不该有错题信号。
- 自动入库**不**关闭 session（不调 `commitImport`）：它在 extraction 与人工 review
  之间跑，人工 review 仍处理剩余 draft 块。

## 触发重新评估

- DEFERRED 的"AI 自动录入 N 条"复查面（slice 3b）落地 → 那时才考虑把 flag 在某环境
  默认 ON（仍需用户显式决定）；复查面可能那时给 `question_block` 加 AI-建议列。
- 若单 pass 聚合在真实数据上误判过多 → 升级 WorkflowJudge（可能引入 LLM judge），在
  此 ADR 记修订，不回退到无闸门自动入库。

## 一句话总结

> Tagging 给 knowledge 建议 + 置信，WorkflowJudge 取最弱环节做确定性裁决；高置信
> 自动入库（generated_by='workflow_judge'，复用 enrollCapturedBlock，零新列），
> 但整条路默认 OFF —— 默认下啥都不自动录，production 不变。
