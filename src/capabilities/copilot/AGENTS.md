# src/capabilities/copilot — Copilot 单人格对话

> D14 单人格对话面：自由对话 + chip 直触 SSE 流、turns 重放、今日摘要、教学 accept-chip 与主动 nudge。工具面经 `copilotTools` 贡献制聚合自各 capability 包。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 9 条 API 路由 + 3 个 jobs + 6 个自有 copilot tools + 7 个 event actions |
| `api/chat.ts` | `/api/copilot/chat` SSE 流入口 |
| `api/cancel-run.ts` | `/api/copilot/runs/[id]/cancel` durable Stop 原子写入面 |
| `api/turns.ts` | `/api/copilot/turns` turns 重放 |
| `api/copilot-summary.ts` | `/api/today/copilot-summary` 今日摘要 |
| `api/accept-chip.ts` | `/api/teaching-sessions/[id]/accept-chip` 教学 chip 接受 |
| `api/nudges.ts` | 主动 nudge 列表与 dismiss/opened 幂等处置 |
| `server/` | chat 编排、turns 读取、summary、stream helpers |
| `ui/CopilotDock.tsx` | 全局 Copilot 抽屉（壳层在 `web/src/router.tsx` 根挂） |

## CONVENTIONS
- 统一记忆读取面 = `server/chat.ts` ambient context + `server/turns.ts`：inline/UI replay
  用 `getRecentCopilotTurns`，durable pickup 用 `getCopilotTurnsBeforeAnchor`，两者复用同一
  row→turn projection；不要另建第三套 reader/projection。
- durable copilot run 走 `copilot_run` pg-boss job（queue='agent'），进度落 `job_events`。
- Stop 以 `job_events` 的 `CANCEL_REQUESTED` 为跨 app/worker 真相源。API 用固定顺序
  dispatch→settlement advisory locks 与 execution fence / outcome marker 线性化；worker 用
  500ms 非重叠 poll、SDK `PreToolUse` 与 async DomainTool gate 覆盖纯文本、SDK 工具和本地
  工具，并把同一 AbortSignal 传给 nested AI。取消终态必须等 in-flight DomainTool
  execute/log/mirror barrier；materializing tool 一旦开始即持久化 `checkpoint_safe:false`。
- durable 终态统一经 `copilot-run-status.ts` 判定；`FAILED(reason='error')` 是可重试帧，
  其它 FAILED reason（含 legacy missing/unknown）按 fail-closed 终态处理。每两分钟
  `copilot_run_reconcile` 只依据 pg-boss 权威状态、持久化 outcome marker 与 execution
  fence / legacy worker-touch evidence 做有界修复；只有 QUEUED-only dead delivery 才能标成
  pre-execution loss。不得用 wall-clock 或 heartbeat timestamp 猜测 live queue run 已死。
- Copilot 自有工具：事件流读、记忆面读、artifact authoring 写。
- YUK-832 FULL evidence reviewer 的 submission tools 是 validator 内部 append-only collector，
  只收小记录并由 server 生成 canonical ledger；它们不是 Copilot/DomainTool 产品能力，不进入
  manifest registry、tool mirror 或用户可见工具面。
- chip 是 Copilot 回复里的可点击动作卡片，accept-chip 把用户选择物化为教学事件。

## ANTI-PATTERNS
- 别把 Copilot 做成通用 AI 调用入口；所有 task 仍走领域 route / worker。
- 别在客户端持 provider key；SSE 也走 `/api/*` token gate。
- Copilot 工具必须经 `copilotTools` 贡献制登记，禁止私自注册。
- 别把 Copilot 当作绕过 capability 边界的后门。
