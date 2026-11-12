# shell — 工作台壳层（M4 新建，YUK-319/YUK-318）

跨域工作台包：统一提议收件箱 + 工作台聚合。提议是跨包横切面（各 kind 分属
practice/agency/ingestion/knowledge/notes 五包，见各包 manifest proposals 声明），
列表/决策的 HTTP 面归这里；各 kind 的 accept applier 仍在归属包，dispatch 经
src/server/proposals/actions.ts 瘦壳。

- api/proposals-list.ts — GET /api/proposals（status/kind/lane/cursor query 由
  server/proposal-inbox-read.ts 校验后交给 inbox 读模型过滤）
- api/proposal-decisions.ts — POST /api/proposals/[id]/decisions（统一不可变
  decision 资源；同决策幂等复用，冲突决策 409，retract 写 correction event）
- server/workbench-summary.ts —
  GET /api/workbench/summary：工作台聚合（Hono handler 在
  server/composed-routes.ts，Start 读者在 server/start/workbench-adapters.ts）。
  proposals KPI（loadTodayProposalKpi）/ due_count（组合层传入的 practice
  queryReviewDue 采样，shell 不 import practice）/ pending_attribution_count
  （listMistakeProjectionRows filter cause===null）/ knowledge_count
  （non-archived count）/ active_sessions（review 会话 + reviewed_count）/
  week_heat（event 近 7 天 BJT 分天 count）
- ui/ —— T6：TodayPage（/today）+ InboxPage（/inbox）+ workbench-api / inbox-api
- 包外依赖：src/kernel/proposals/inbox（收件箱读模型）、src/server/proposals/actions
  （跨包横切面瘦壳）、practice/scheduling/server/due-list、
  src/kernel/read-models/mistake-projection
- server/proposal-kpi.ts — 工作台完整提议计数投影（含人工决定计数与扫描下界信号）。
- 其余 api/ 覆盖 /api/subjects、/api/proposals 的 auto-applied 与 batch-accepts、
  /api/workbench 的 overnight-digest 与 ai-notices、/api/prep-desk 的
  conjectures/probes/brief；路由归属以 manifest.ts 为准。
