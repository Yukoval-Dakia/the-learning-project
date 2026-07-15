# src/capabilities/copilot — Copilot 单人格对话

> D14 单人格对话面：自由对话 + chip 直触 SSE 流、turns 重放、今日摘要、教学 accept-chip 与主动 nudge。工具面经 `copilotTools` 贡献制聚合自各 capability 包。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 7 条 API 路由 + 2 个 jobs + 5 个自有 copilot tools + 7 个 event actions |
| `api/chat.ts` | `/api/copilot/chat` SSE 流入口 |
| `api/turns.ts` | `/api/copilot/turns` turns 重放 |
| `api/copilot-summary.ts` | `/api/today/copilot-summary` 今日摘要 |
| `api/accept-chip.ts` | `/api/teaching-sessions/[id]/accept-chip` 教学 chip 接受 |
| `api/nudges.ts` | 主动 nudge 列表与 dismiss/opened 幂等处置 |
| `server/` | chat 编排、turns 读取、summary、stream helpers |
| `ui/CopilotDock.tsx` | 全局 Copilot 抽屉（壳层在 `web/src/router.tsx` 根挂） |

## CONVENTIONS
- 统一记忆读取面 = `server/chat.ts` ambient context + `server/turns.ts` `getRecentCopilotTurns`；不另立抽象。
- durable copilot run 走 `copilot_run` pg-boss job（queue='agent'），进度落 `job_events`。
- Copilot 自有工具：事件流读、记忆面读、artifact authoring 写。
- chip 是 Copilot 回复里的可点击动作卡片，accept-chip 把用户选择物化为教学事件。

## ANTI-PATTERNS
- 别把 Copilot 做成通用 AI 调用入口；所有 task 仍走领域 route / worker。
- 别在客户端持 provider key；SSE 也走 `/api/*` token gate。
- Copilot 工具必须经 `copilotTools` 贡献制登记，禁止私自注册。
- 别把 Copilot 当作绕过 capability 边界的后门。
