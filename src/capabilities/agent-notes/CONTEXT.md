# agent-notes — AI 内部协调信道（P1 打样首包，YUK-311）

小 task（quiz_verify 等）给三个定时大 agent（dreaming/maintenance/coach）留观察信号；
hints not facts，带 provenance + expires_at。存储零新表：骑乘
event(action='experimental:agent_note')（U0 D10 / AF §4）。用户面只有只读观察窗
（/agent-notes 页 + today 块）。应然定位 = spec D7：幕后基础设施；观察窗去留是
菜单 ⚖️ 行（P4 关口裁决）。

- server/notes.ts — writeAgentNote / readAgentNotes / readAllAgentNotes
- api/notes.ts — GET /api/agents/notes（外壳 app/api/agents/notes/route.ts 挂载）
- ui/ — 看板/卡片/derive/meta/已读态/页面（外壳 app/(app)/agent-notes/page.tsx 挂载；
  today 页直接 import AgentNotesBoard）
- 包外读写方：写 = src/server/boss/handlers/quiz_verify.ts；
  读 = dreaming_nightly / coach_daily / src/server/knowledge/review.ts
