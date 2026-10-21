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
  version: 1, captured_at, session_status,
  run_state: 'in_progress'|'waiting'|'done'|'failed'|'lost',
  execution_closed: boolean, paid_outcome_unknown: boolean,
  stage, segments: [{segment, trigger, outcome?, task_run_id?, at}],
  items: [{item_id, question_no, status, reason?, page?, preview_md?,
           draft_ref?, question_id?, status_at?}],
  asks:  [{ask_id, item_id, question_no, prompt_md, answer_kind, options?,
           placeholder, expires_at, created_at,
           resolved: null | {answer, via:'answer'|'timeout', at}}],
  errors: [{scope, item_id?, code, retryable, at}], errors_truncated,
}
```

- `persistAgentRunHistory(tx, {sessionId, runState, executionClosed,
  paidOutcomeUnknown})`：在终态/暂停事务内重读 ledger（尊重
  `execution_owner.event_floor`，只看当前 run）+ ask/error/segment 时间戳，
  经 `writeAgentBudgetPath(tx, sid, ['history'], snap)` 覆盖写。快照语义 =
  "当前 run 最近一次已提交检查点"。
- `readAgentRunHistory(db, sid)`：读 snapshot + live ledger；逐 item/ask 合并
  （live 行存在则为准，snapshot 补已裁剪行），返回 `evidence{snapshot,
  live_events}`。都没有 → 各切片空 + missing 标记。
- 旧会话（本片快照上线前已终态的 run）：>30 天后只有 question/block 行可证，
  items/asks 空 + `missing` 标记 —— 不伪造。

### 2. 列表修复（G1）— `api/sessions.ts` GET

- 谓词放宽：直挂 blocks ∪ `draft:ingestion_agent:<sid>` blocks ∪ agent 证据
  （`agent_budget->'operations'|'grants'|'history'` 非空）。extract-only 语义不变。
- 每行加：`path:'agent'|'extract'|null`、`item_count`（agent：submitted question
  roots ∪ draft blocks；extract：block_count）、`started_at`、`ended_at`、
  `title`/`title_source`（source_document.title，今天恒 null——如实）。

### 3. 历史读面（G2–G5/G9/G13）— `GET /api/ingestion-sessions/:id/history`

新路由（canonical family），`api/session-history.ts` 组装：

```
{ session:{id,status,path,entrypoint,source_document_id,source_asset_ids,
           started_at,ended_at,created_at,updated_at,error_message,warnings},
  run: null | {run_state,stage,segment_count,started_at,finished_at,
               execution_closed,paid_outcome_unknown,counts,errors[]},
  items: [{item_id,ordinal,question_no,page,source_asset_ids[],
           preview_md,preview_truncated,state_at_finish,reason,
           draft_block_id,question_id,status_at,
           current:{draft_status,servable,hold_reason,held_since,
                    next_action,pending_action}|null}],
  asks:  [{ask_id,item_id,question_no,prompt_md,answer_kind,options,
           placeholder,expires_at,created_at,
           resolved:null|{answer,via,at},unresolved,expired_unresolved}],
  evidence:{snapshot,live_events,missing[]} }
```

- extract lane item = question_block 行（durable）；agent lane item = merged
  ledger ∪ draft blocks ∪ source_ref questions。
- `state_at_finish` 是当时结果；`current.*` 是现在准入/held 状态，两字段并存
  （G4）。hold_reason/原因 null 合法，不猜。
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
