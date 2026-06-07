// Wire shape of an agent note as the board receives it over JSON.
//
// Mirrors AgentNote in src/server/agents/notes.ts, EXCEPT created_at is a string
// (Date is serialised by Response.json). Kept as a board-local type so the UI
// never imports server runtime code — only this structural contract.

export interface BoardAgentNote {
  id: string;
  created_at: string;
  target_agents: string[];
  source_task_kind: string;
  source_task_run_id?: string;
  refs: Array<{ kind: string; id: string }>;
  summary_md: string;
  signal_kind: string;
  confidence?: number;
  expires_at?: string;
  caused_by_event_id?: string;
}

export interface AgentNotesResponse {
  rows: BoardAgentNote[];
}
