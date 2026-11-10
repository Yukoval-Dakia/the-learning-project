# agency — 能动编排（M4 吞并改名，YUK-319；前身 agent-notes，P1 打样首包 YUK-311）

夜间链路 + AI 内部协调信道一体的能动包：dreaming / coach（学习者回访时按需唤醒）/ goal scope 提议
定时与按需 job（manifest jobs 声明是唯一归属源），加上小 task（quiz_verify 等）给
大 agent 留观察信号的 agent-notes 信道——hints not facts，带 provenance +
expires_at。存储零新表：骑乘 event(action='experimental:agent_note')（U0 D10 /
AF §4）。用户面只有只读观察窗（/agent-notes 页 + today 块）。

- jobs/ — dreaming_nightly（03:15 agent 档）/ coach_daily（llm 档，不在夜链：学习者回来且
  计划过期时由 learner_return_wake 经 kernel/coach-wake 入队）/
  goal_scope_propose_nightly（03:50 llm 档，sibling goal_scope_dedup）
- server/goals/ — accept / queries / scope（goal scope 提议的读写与验收）
- server/notes.ts — writeAgentNote / readAgentNotes / readAllAgentNotes
- api/notes.ts — GET /api/agents/notes（外壳 app/api/agents/notes/route.ts 挂载）
- ui/ — 看板/卡片/derive/meta/已读态/页面（外壳 app/(app)/agent-notes/page.tsx 挂载；
  today 页的 AgentNotesBoard 由路由壳注入 shell TodayPage）
- 包外读写方：notes 写 = src/server/boss/handlers/quiz_verify.ts；
  notes 读 = src/capabilities/knowledge/server/review.ts、`jobs/coach_daily.ts`、curator 输入（写给 dreaming）、研究会选格子（写给 research_meeting，加权并注入归纳输入）；
  goals 读 = practice due-list / learning-items queries（注意力先验）；
  goals accept = src/server/proposals/actions.ts（T4 解体后进包）
- M5 seam：scope.ts / goal_scope_propose_nightly.ts 跨包深 import
  knowledge/server/tree（loadTreeSnapshot），M5 收紧包边界时换 knowledge 对外导出面
