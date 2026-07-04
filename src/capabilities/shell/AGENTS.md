# src/capabilities/shell — 工作台壳层

> 跨域工作台：提议收件箱（17 kind 全量统一 decide/retract）+ 工作台聚合（今日 KPI / due / 待归因 / 知识量 / 进行中会话 / 7 天活动热力 / 昨夜 digest）。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 6 条 API 路由 + `/today` `/inbox` `/coach` 三页 + todayBlocks |
| `api/proposals-list.ts` | 跨 capability pending proposal 列表 |
| `api/proposals-auto-applied.ts` | A 档 auto-applied 卡与裁决熔断快照 |
| `api/proposal-decide.ts` / `proposal-retract.ts` | 统一 decide / retract 入口 |
| `api/workbench-summary.ts` | 工作台聚合 KPI |
| `api/overnight-digest.ts` | 昨夜窗 digest |
| `api/prep-desk-conjectures.ts` | 备课台 top pending conjectures |
| `server/` | proposals reader/decider/retract、workbench 聚合、overnight digest |
| `ui/TodayPage.tsx` / `InboxPage.tsx` / `CoachHub.tsx` | 今日、收件箱、Coach 周报 |

## CONVENTIONS
- `/api/proposals` 跨 capability 聚合所有 pending proposal；decide/retract 按 kind 路由到对应 capability 的 applier。
- workbench summary 是读模型，不拥有业务事实；数据源来自各 capability 的聚合端点。
- todayBlocks 由各 capability 贡献（agency 的 agent-notes-board、notes 的 ai-changes-strip、observability 的 cost-ribbon），shell 只组装。
- 收件箱 count 与 TodayPage 复用同一 `workbench-summary` query key，React Query 自动去重。

## ANTI-PATTERNS
- 别在 shell 里硬编码某个 capability 的业务规则；只聚合。
- 别把 proposal decide 逻辑散落在 shell；shell 只做路由到归属 capability 的 applier。
- 工作台数据是 projection，不要回写源表。
