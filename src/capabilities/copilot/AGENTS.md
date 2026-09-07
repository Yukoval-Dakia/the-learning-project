# src/capabilities/copilot — Copilot 单人格对话

> 单人格对话面：自由对话与 chip 共用持续会话、可恢复进度和 turns 重放；另有今日摘要、教学 accept-chip 与主动 nudge。工具面经 `copilotTools` 贡献制聚合自各 capability 包。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | API、jobs、copilot tools 与 event actions 的组合入口 |
| `api/chat.ts` | `/api/copilot/chat` 持久接纳入口（202、稳定幂等键） |
| `api/cancel-run.ts` | `/api/copilot/runs/[id]/cancel` durable Stop 原子写入面 |
| `api/turns.ts` | `/api/copilot/turns` 会话快照、turns 与 active_runs 恢复 |
| `api/copilot-summary.ts` | `/api/today/copilot-summary` 今日摘要 |
| `api/accept-chip.ts` | `/api/teaching-sessions/[id]/accept-chip` 教学 chip 接受 |
| `api/nudges.ts` | 主动 nudge 列表与 dismiss/opened 幂等处置 |
| `server/` | 持久接纳/执行、turns 读取、summary、stream helpers 与 teaching 编排 |
| `tasks/` | Copilot 自有三个 TaskSpec（agent / research / teaching-turn） |
| `ui/CopilotDock.tsx` | 全局 Copilot 抽屉（壳层在 `web/src/router.tsx` 根挂） |

## CONVENTIONS
- 生命周期遵循 ADR-0062：消息持久接纳后由服务端执行；断线/关抽屉只脱离订阅，只有显式 Stop 取消。
  后续消息在同一会话按输入事件顺序排队，不以 session_busy 或先 Stop 为发送前提。
- `server/turns.ts` 统一历史投影：快照使用当前会话 reader，worker 使用因果 anchor reader，
  将晚于后续输入到达的前轮回复归回前轮；不要另建第三套 reader/projection。
- `server/durable-dispatch.ts` 拥有 FIFO 接纳和派发：只有最早未终结消息有物理 `copilot_run` job。
  终态提交后才能唤醒后继；合法等待消息没有 pickup 超时，DISPATCHED 才启动 pickup 计时。
- `server/copilot-execution.ts` 拥有公共模型/工具/读取预算与发布校验；持续运行不意味着抬高默认预算。
  SDK id 只有本进程确实持有且实际提交文本匹配时才可复用；异进程从产品历史冷启，不重烧已执行消息。
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
- 工具归属以 `manifest.ts` 为准；artifact 创建/更新属于 [Notes manifest](../notes/manifest.ts)，Copilot 仅持调用授权与呈现控制。
- 根任务以 terminal Markdown 收口；服务端在 SDK terminal 后绑定实际 root trace、更正、proposal 披露与学习内容校验。
  [ADR-0061](../../../docs/adr/0061-copilot-presentation-intent-control.md) 允许 agent 看完结果后按需调用 `present_primary_view` 提名成品，服务端校验后发布；该短交互仍受既有执行预算约束。
- chip 是 Copilot 回复里的可点击动作卡片，accept-chip 把用户选择物化为教学事件。

## ANTI-PATTERNS
- 别把 Copilot 做成通用 AI 调用入口；所有 task 仍走领域 route / worker。
- 别在客户端持 provider key；SSE 也走 `/api/*` token gate。
- Copilot 工具必须经 `copilotTools` 贡献制登记，禁止私自注册。
- 别把 Copilot 当作绕过 capability 边界的后门。
