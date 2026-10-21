# 录入历史还原 — 后端 live-consumer 片（YUK-1522）

2026-10-21 · lane: `feat/ingestion-history-readback` @ `t3-e45fefa5`

## 目标（已批）

历史打开录入会话能还原 after-upload 视图：会话列表含 agent 会话、逐题读面
（页码/原 asset/预览/状态/held-back 原因/question_id）、追问与回答、长期保留。
只交后端读面 + 持久快照接线；无 UI、无预算/cost/OCR/provider 改动。

## 现状核查要点（代码事实，非计划）

- 会话 = `learning_session(type='ingestion')`；列表 `api/sessions.ts` 用
  `exists(question_block.ingestion_session_id = s.id)` 过滤 —— agent 草稿挂在
  `draft:ingestion_agent:<sid>` 下，agent 会话因此消失（G1 根因）。
- Agent 题经 `edit_question` 产 `question_block`（draft: 前缀）+ `submit_question`
  产 `question(source='photo_ingest', source_ref='ingestion_agent:<sid>',
  metadata.draft_block_id=block.id)`。`draft_ref === question_block.id`。
- Agent 运行账本在 `job_events`（30 天 TTL）：session 流 stage/item/ask/error，
  `ingestion_agent_run` 流 item_state/run_segment/paid_attempt，每 ask 一条
  `ingestion_ask` 流（created/answer_claimed/resolved）。超过 30 天全部消失（G7）。
- PR#1891 已把 agent operation 身份/终态落到 `agent_budget.operations|grants`
  （持久、无 TTL）——G6 已修，本片只读它不重做。
- `learning_session.agent_budget` 是 jsonb envelope，`writeAgentBudgetPath`
  提供 additive 子树写入并保留未知字段 —— 天然是长期快照宿主，**不需要
  schema 迁移**（也正好避开开放 PR #1944/#1926 对 `src/db/schema.ts` 的占用）。
- `question-serving` 读模型提供 `servable/hold_reason/held_since/next_action/
  pending_action`；未知为 null，不猜。
- `ended_at` 只在 `commitImport` 写；`started_at` 在创建时写。

## 方案

### 1. 持久快照（G7）— `server/agent/history.ts`（新 owner）

`agent_budget.history` 子树，由本模块独占写读：

```
AgentRunHistorySnapshot {
  version: 2, captured_at, session_status,
  run_state: 'in_progress'|'waiting'|'done'|'failed'|'lost',
  execution_closed: boolean, paid_outcome_unknown: boolean,
  run_ref?: execution_owner.run_ref,      // v1 快照无 —— 永远归属 prior_runs
  event_floor: job_events.id floor,       // 低于此 id 的事件属上一 run
  stage, segments: [{segment, trigger, outcome?, task_run_id?, event_id?, at}],
  items: [{item_id, question_no, status, reason?, page?, preview_md?,
           draft_ref?, question_id?, status_at?}],
  asks:  [{ask_id, item_id, question_no, prompt_md, answer_kind, options?,
           placeholder, expires_at, created_at,
           resolved: null | {answer, via:'answer'|'timeout', at}}],
  errors: [{scope, item_id?, code, retryable, event_id?, at}], errors_truncated,
  prior_runs?: [上一个 run 的整块降级 checkpoint，newest first],
  unparsed_previous?: 未过 schema 的旧快照原样保留（绝不解释、绝不丢）,
}
```

- `persistAgentRunHistory(tx, {sessionId, runState, executionClosed,
  paidOutcomeUnknown})`：在终态/暂停事务内重读 ledger（尊重
  `execution_owner.event_floor`，只看当前 run）+ ask/error/segment 时间戳。
  **Run 隔离**：`execution_owner.{run_ref,event_floor}` 是 run 身份；快照
  run_ref 不匹配（或 v1 无身份）→ 整块降级进 `prior_runs`（≤5，newest
  first），新 run 不继承旧 run 的 run_state/execution_closed/stage。
  **增量合并**：同 run 时 items/asks 按 id 合并（live 覆盖同 id 行），
  segments/errors 按 `event_id`（旧行无 id 时按内容键）union 去重——已
  持久化的行不因 live 窗口 TTL 裁剪而消失。经
  `writeAgentBudgetPath(tx, sid, ['history'], snap)` 写自己子树。
- `readAgentRunHistory(db, sid)`：同上 run-identity 判定，只有身份匹配的
  快照进 current-run 合并；不匹配的整块走 `prior_runs`（live 行永不覆盖
  prior run）。返回 `run_ref` + `prior_runs[]` + `evidence{snapshot,
  live_events}`。都没有 → 各切片空 + missing 标记。
- 旧会话（本片快照上线前已终态的 run）：>30 天后只有 question/block 行可证，
  items/asks 空 + `missing` 标记 —— 不伪造。

### 2. 列表修复（G1）— `api/sessions.ts` GET

- 谓词与详情同源：`agentEvidenceSql(sid)`（history.ts 导出，list 与 history
  两端共用）= bound blocks ∪ `draft:ingestion_agent:<sid>` draft blocks ∪
  `source_ref='ingestion_agent:<sid>'` questions ∪ agent_budget
  operations/grants/history ∪ 存活 run events。legacy 会话只剩 durable
  draft/question 行也分类 agent（其原始 item 状态为 unknown，不标 extract）。
  extract-only 语义不变。
- 每行加：`path:'agent'|'extract'|null`、`item_count`（agent：submitted question
  roots ∪ draft blocks；extract：block_count）、`started_at`、`ended_at`、
  `title`/`title_source`（source_document.title，今天恒 null——如实）。

### 3. 历史读面（G2–G5/G9/G13）— `GET /api/ingestion-sessions/:id/history`

新路由（canonical family），`api/session-history.ts` 组装：

```
{ session:{id,status,path,entrypoint,source_document_id,source_asset_ids,
           started_at,ended_at,created_at,updated_at,error_message,warnings},
  run: null | {run_ref,run_state,stage,segment_count,started_at,finished_at,
               execution_closed,paid_outcome_unknown,counts,errors[]},
  prior_runs: [降级 checkpoint 原样：run_ref,captured_at,session_status,
               run_state,stage,execution_closed,paid_outcome_unknown,
               items[],asks[],segments[],errors[]],
  items: [{item_id,ordinal,question_no,page,source_asset_ids[],
           preview_md,preview_truncated,state_at_finish,reason,
           draft_block_id,draft_ref,question_id,status_at,
           current:{draft_status,servable,hold_reason,held_since,
                    next_action,pending_action}|null}],
  asks:  [{ask_id,item_id,question_no,prompt_md,answer_kind,options,
           placeholder,expires_at,created_at,
           resolved:null|{answer,via,at},unresolved,expired_unresolved}],
  evidence:{snapshot,live_events,missing[]} }
```

- extract lane item = question_block 行（durable）；agent lane item = merged
  ledger ∪ draft blocks ∪ source_ref questions。
- **冻结证据原则**（R1 F2）：`state_at_finish` 只取 item_state 捕获（agent
  lane）或 'unknown'（durable 链接行无 at-finish 证据——question.status /
  question_block.status 是可变投影，永不冒充）；`preview_md` 只取冻结
  preview_md（item_state q_md）或 immutable `extracted_prompt_md`，不取
  mutable `question.prompt_md`。`current.*` 是现在准入/held 状态，两字段
  并存（G4）。hold_reason/原因 null 合法，不猜。
- **draft ref 归一化**（R1 F1）：`draft_ref` 保留原始 `qdraft1:<block>:<v>`
  版本串；join/claimed/output 用 `src/core/question-draft-ref.ts` 共享
  codec 归一化的 `draft_block_id`。
- `source_asset_ids`：item.page 有时按 `source_asset_ids[page-1]` 顺序约定映射
  （§4.1 同约定）；block 有自己的 `source_asset_ids` 时直接用；都没有则 `[]`。
- 追问 `resolved:null` 永不伪造成 timeout（G13）；`expired_unresolved` 标记
  expires_at 已过仍 open 的。

### 4. run.ts 接线（写方）

`persistAgentRunHistory` 插入每个已有结算事务（就地一行）：
over_cap、waiting×2、terminal_request×2、policy_blocked、model-fail、done、
finalizeRun、early_exit、failSessionForUnknownPaidAttempt。

## 明确不做

G8 bbox/框、G10 分段 receipt 聚合、G11 用途更改端点、G12 每会话费用；
schema.ts / 迁移 / `server/session/ingestion.ts` 状态机不动（无共享 hunk 冲突
——#1944/#1926 只碰 schema.ts 与 postman，本片 postman 为 additive 重新生成）；
无测试、无 DB/provider/paid 验证。

## 长期契约

- 新 run 快照在每次 segment 关闭时刷新 → 30 天后仍有完整 items/asks/outcome。
- item → question 链：item_state.question_id → 回退 metadata.draft_block_id →
  source_ref；`current` 由 question-serving 读模型裁决。
- 缺证据一律 null/`missing[]`，调用方按 unknown 渲染。
