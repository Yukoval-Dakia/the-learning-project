# Copilot Agentic-UX 接线审计 — designed vs wired 真相

**Date**: 2026-06-20
**Trigger**: owner dogfooding 观察「tool-use cards + backtrace/checkpoint 没接线」+ copilot propose 任务反复失败（error_max_turns / aborted）。
**Method**: 5 路并行 code-ground（opus）+ 统合，把 Linear Done 当嫌疑逐条核源码。Workflow `wf_24faa6a9-854`。

## 根因结论

**这不是 bug，是有意的 backend-ahead-of-UI 分层 + 一个 design-only 的地基（ADR-0044）。** 五条腿：三条「后端建好、缺最后一公里 UI 接线」，一条「地基没动不能建」，一条「决策 ratify 但落地形 deferred」。

owner 的 copilot propose 失败（mimo→error_max_turns / GLM→aborted）**同源**：`durable` 分支是死代码（router 退化成 raw boolean `req.durable`，production 零 caller 设它 → 全走 inline），长/慢 run 在 inline 请求窗口内必死。**换 provider 治不了——是 endurance 缺口。**

## 1. designed-vs-wired 真相表

| Leg | wiredState | 关键证据 (file:line) | 缺口 | Effort |
|---|---|---|---|---|
| **durable-run 后端** | backend-only-no-ui | handler 建好且 worker-mounted `copilot_run.ts:116-320` / `manifest.ts:49-58`；dispatch 存在 `api/chat.ts:63-103`；**但 router = raw boolean** `server/chat.ts:179-186`；**production 零 caller 设 durable** `CopilotDock.tsx:361-369`（grep `durable:true`=0）→ durable 分支死代码，全走 inline | 真阈值 router（或 Dock 适时 set durable）+ `/api/copilot/runs/[id]/events` replay 路由 + Dock run-card 订阅 | L |
| **run-card / 进度 UI** | backend-only-no-ui | manifest **无** `copilot/runs/:id/events` `manifest.ts:22-43`；durable path 返 202 非 SSE `api/chat.ts:101-103`；唯一 SSE hook 硬编码 ingestion `sse.ts:29,51`；worker 只发粗粒 STARTED/REPLY/DONE/FAILED（STEP 是占位）`copilot_run.ts:188-312`；自述「当前无 UI 消费者」`copilot-run-status.ts:7,62` | replay 路由（镜像 `ingestion/api/events.ts`）+ granular 事件 + RunCard | L |
| **tool-use card 渲染** | backend-only-no-ui | runner 只把 assistant text 转 onDelta，tool_use 块只进 `writeToolCallLog`（DB）不进 stream `runner.ts:1006-1039`；SSE 只发 delta/reply 两帧 `api/chat.ts:146-170`；Dock parseSseStream 无 tool_use 分支 `CopilotDock.tsx:378-408`；**`ToolUseCard.tsx` primitive 建好但零 production importer**；CSS 已 port 无组件挂 `globals.css:9030-9268` | 后端线 tool_use SSE 帧（runner→chat.ts）+ 前端挂已建好的 ToolUseCard | M-L |
| **per-utterance checkpoint+revert** | **blocked-on-foundation** | `computeReplay` 只 SELECT job_events 零 projection 重建 `sse_replay.ts:27-48`；`getEventChain` 单跳无递归 `queries.ts:943-977`；地基全缺（`cascade.ts`/`revert/`/`projections/`/`state_snapshot`/checkpoint 表 grep=0）；最近似 undo 是单 artifact 单事件 `note-refine-apply.ts:254-362`；**YUK-363「Done」= 设计 ratify（attachment 全是 docs commit / PR #416）** | 整条 ADR-0044 地基先建（fold/snapshot/cascade/payload）**然后**才 PR 对象+revert 端点+diff UI | XL |
| **reach dispatcher** | deferred-not-built | registry 无 `intentSchema/invocable/.copilot` 字段 `registry.ts:40-63`；ADR-0041:65-67 显式列 deferred；COPILOT_TOOLS 仍手维护 26 字面量 `allowlists.ts:150-217` | TaskDef 加 `copilot?:{intentSchema,prepare,invocable}` 契约 | L |

## 2. Linear 状态对账（驾驶舱防腐）

| Linear | 标称 | 真相 |
|---|---|---|
| **YUK-364** durable-run | Done（后端腿） | **PARTIAL** — 后端契约 Done 真，但零 caller + 无 SSE 消费 + 无 UI = 生产死代码 |
| **YUK-307** async tracker | — | **STALE** — 用户可见进度（run-card）完全未 ship |
| **YUK-363** checkpoint/revert | **Done** | **STALE 最危险** — 「Done」是设计 ratify，code Waves 0-3 一行未写；一个 XL 地基在看板显绿 |
| **YUK-457** tool-use cards | — | **PARTIAL** — primitive+CSS+fixtures 建好，wiring lane 未建 |

## 3. 关键判定

- **checkpoint/rewind 必须先解 event-sourcing 地基（ADR-0044）？** → **是，硬依赖无绕路。** revert 需 projection 重建，但系统是 event-**logged** 非 event-**sourced**；在地基上糊 UI = 假回溯 + 损坏 θ̂/FSRS。XL。
- **run-card UI 可独立做（后端桥 Done）？** → **是，tractable。** 缺口纯是 replay SSE 路由（有 1:1 模板 `ingestion/api/events.ts`）+ SSE hook + Dock 渲染。不碰地基。
- **tool-use card 可独立做？** → **是，甚至在现有 inline stream 上发帧即可，连 durable 都不必先解。**

## 4. 接线方案（分档）

### 档 A — tool-use card 接线（YUK-457）· effort M-L · **建议插队 cold-start**
后端 runner 加 `onToolUse` 回调 + chat.ts 加 tool_use 帧；前端 parseSseStream 加分支 + 挂已建好 ToolUseCard；turns.ts echo。**不依赖 durable/地基。** 直接修 owner dogfooding 最刺眼的「只看到 final text，看不到 agent 调了啥」。性价比最高。

### 档 B — durable 消费端 + run-card（YUK-307 收口，激活 YUK-364）· effort L · cold-start wave 后
加 `/api/copilot/runs/:id/events`（镜像 ingestion）+ 泛化 SSE hook + Dock set durable + RunCard。**降档**：先用粗启发（needsToolCall / 显式 deep 按钮）set durable，把「激活 durable + 可观测」与「智能路由」解耦。**这才是 copilot propose 失败的真修**（长 run 不再死在 inline）。

### 档 C — 暂不做（明确 DO NOT）
- **checkpoint/revert（YUK-363）**：ADR-0044 地基建好前不碰任何 revert UI/端点（XL 地基 + 假回溯风险）。先改正看板状态，地基独立大项立项。
- **reach dispatcher / 真阈值 router**：决策 ratify 但当前手接线工作正常，低优内部重构，地基/UX 之后。

### 与 cold-start 取舍
copilot agentic-UX **不值得整体中断 cold-start**，但 **A1（tool-use card）例外值得插队**（纯 wiring、回归小、每次交互都触发）。B1 sequence after。C 全部 after（checkpoint 是与 cold-start 同级的独立 XL 立项）。

## 收尾动作
1. YUK-363 Done → 改正为「design ratified, impl not started」（拆 impl 子单）。
2. YUK-364/307/457 标 partial + 各拆「UI 接线 lane」子单。
3. ADR-0044 地基单独立 XL 项。
