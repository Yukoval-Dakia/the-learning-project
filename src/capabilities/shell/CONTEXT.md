# shell — 工作台壳层（M4 新建，YUK-319/YUK-318）

跨域工作台包：统一提议收件箱 + 工作台聚合。提议是跨包横切面（17 kind 分属
practice/agency/ingestion/knowledge/notes 五包，见各包 manifest proposals 声明），
列表/决策的 HTTP 面归这里；各 kind 的 accept applier 仍在归属包，dispatch 经
src/server/proposals/actions.ts 瘦壳。

- api/proposals-list.ts — GET /api/proposals（旧 app/api/proposals 等价平移 +
  kind query 增量；kind 过滤是路由层页内 post-filter，inbox 读模型不感知 kind）
- api/proposal-decide.ts — POST /api/proposals/[id]/decide（旧 accept+dismiss
  合并；decision 必填四值 'accept'|'reverse'|'change_type'|'dismiss'）
- api/proposal-retract.ts — POST /api/proposals/[id]/retract（等价平移）
- server/workbench-summary.ts + api/workbench-summary.ts —
  GET /api/workbench/summary：today 重生聚合（新端点，设计自由）。
  proposals KPI（loadTodayProposalKpi）/ due_count（内部 Request 调 practice
  handleReviewDue，M5 提炼 read 函数后换直调）/ pending_attribution_count
  （listMistakeProjectionRows filter cause===null）/ knowledge_count
  （non-archived count）/ active_sessions（review 会话 + reviewed_count）/
  week_heat（event 近 7 天 BJT 分天 count，旧 today 页 OMITTED 的新聚合）
- ui/ —— T6：TodayPage（/today）+ InboxPage（/inbox）+ workbench-api / inbox-api
- 包外依赖：src/server/proposals/{inbox,actions}（跨包横切面瘦壳）、
  practice/server/due-list、src/server/records/mistakes、
  src/server/today/proposal-kpi
