# src/capabilities/agency — 能动编排

> 夜间链路（dreaming / coach / maintenance / research meeting）+ goal scope 提议 + agent-notes。agent-notes 是 AI 内部协调信道（hints not facts），用户侧只读观察窗。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 5 条 API 路由 + 6 个 cron job + 6 proposal kinds + 7 copilot tools + 1 event action + todayBlock |
| `api/*.ts` | agent-notes、goal-create、probe-answer（conjecture 判别探针作答，#13 通电——与 attempt/FSRS 写面隔离，只写 1 个 `experimental:probe_result` 事件） |
| `server/` | dreaming nightly、coach daily/weekly、goal scope propose、conjecture、agent-notes、proposal-appliers、`meeting/`（YUK-572 agent-led 例会 director + 写工具） |
| `jobs/` | `dreaming_nightly`、`coach_daily`、`coach_weekly`、`goal_scope_propose_nightly`、`research_meeting_nightly`、`research_meeting_agent_nightly`（YUK-572 shadow lane，kill switch `RESEARCH_MEETING_AGENT_ENABLED` 默认 OFF） |
| `ui/AgentNotesPage.tsx` | `/agent-notes` 观察窗 |

## CONVENTIONS
- 夜链 cron 全部 `Asia/Shanghai`；pg-boss cron 自带 singleton 语义。
- queue 档：`agent` 给多 tool-call LLM job（dreaming、research meeting）；`llm` 给单次/轻量 LLM job（coach）。
- proposal kind 归属与 applier 存在性解耦：有 producer 无 accept applier 的 kind（如 `defer`）在 dispatch 壳 default throw。

## ANTI-PATTERNS
- 别把 agent-notes 当用户可写的事实层；它是 hint channel。
- 别让夜链直写硬事实；产出必须是 propose event，用户 accept 才落地。
- 改 cron 时刻前先看链上 offset 注释，避免锁竞争/读不到同夜 proposal。
