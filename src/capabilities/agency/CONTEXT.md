# agency — 能动编排（M4 吞并改名，YUK-319；前身 agent-notes，P1 打样首包 YUK-311）

夜间链路 + AI 内部协调信道一体的能动包：dreaming / coach（学习者回访时按需唤醒）/ goal scope 提议
定时与按需 job（manifest jobs 声明是唯一归属源），加上小 task（quiz_verify 等）给
大 agent 留观察信号的 agent-notes 信道——hints not facts，带 provenance +
expires_at。存储零新表：骑乘 event(action='experimental:agent_note')（U0 D10 /
AF §4）。用户面只有只读观察窗（/agent-notes 页 + today 块）。

- jobs/ — dreaming_nightly（agent 档，夜链成员：soft 依赖 knowledge_maintenance_nightly）/
  coach_daily（llm 档，不在夜链：学习者回来且计划过期时由 learner_return_wake 经
  kernel/coach-wake 按义务入队；输入含昨天重点的结算结果（计划 id 先映到存活节点，再按合并闭包计已结算作答），以及 review_plan 上的到期知识点名称、逾期天数、保持率、掌握档；工具面含知识维护的图谱读取）/ goal_scope_propose_nightly（llm 档，夜链根；cron 移除，
  orchestrator 触发，sibling goal_scope_dedup）
- server/goals/ — create / accept / scope（goal scope 提议的读写与验收）
- server/notes.ts — writeAgentNote / readAgentNotes / readAllAgentNotes
- api/notes.ts — GET /api/agents/notes
- ui/ — 看板/卡片/derive/meta/已读态/页面（Start 路由 server/start/routes/agent-notes.tsx；
  today 页的 AgentNotesBoard 由 server/start/routes/today.tsx 注入 shell TodayPage）
- 读写方：notes 写 = server/notes.ts（quiz_verify 事件经
  server/question-pool-gap-subscription.ts 转 coach hint）；notes 读 =
  knowledge/server/review.ts（经 kernel/read-models/agent-note-hints）、
  `jobs/coach_daily.ts`、curator 输入（写给 dreaming）、研究会选格子（写给 research_meeting，
  加权并注入归纳输入）；
  goals 读 = practice due-list（注意力先验）/ supply_planner（经
  kernel/read-models/active-goal-scope）；goals accept = server/goals/accept.ts（dispatch 经
  src/server/proposals/actions.ts）
- 知识树读取 = kernel/read-models/knowledge-graph（loadTreeSnapshot），
  scope / goal_scope_propose_nightly 共用
