# ADR-0054 - Persist and resume Copilot Agent SDK session across HTTP turns

**Status:** Proposed
**Decision source:** YUK-936; Eng Lead architecture pass at main `2b22d5d70d46f487592f6966a9b7ad980e3bd40e`
**Related:** ADR-0041 · ADR-0051 · ADR-0052 · ADR-0053 · YUK-842 · YUK-575 · YUK-927 (do not reopen)

## Context

OpenCode and Claude Code own a live session. The server persists the user message, runs the tool loop,
and exits when the turn is finished. HTTP is a client.

TLP Copilot does the opposite. `POST /api/copilot/chat` mints a cold `CopilotTask` every time
(`src/capabilities/copilot/server/chat.ts` then `streamTaskCollecting`). `src/server/ai/runner.ts`
`buildQueryOptions` hardcodes `persistSession: false` and never passes `resume`. Continuity is a
Postgres `learning_session` plus a bounded `{role,text}` fold (`assembleConversationHistory`, 8 turns ×
800 chars, 4000 total) stuffed into `JSON.stringify(CopilotRunInput)`. The Agent SDK session id is
discarded.

That HTTP-request machine is why F5 invented ToolOperations (45s yield) and the ADR-0053 mailbox
instead of blocking tools and returning native Task results into a live parent. This ADR unlocks
live-session resume for ordinary foreground chat. It does not delete those F5 mechanisms.

YUK-842 admits a complete `startup()` + `WarmQuery.query()` family, not an HTTP request. A nested
same-lane DomainTool may borrow the parent family slot. A parallel sibling may not. Each child still
takes a start-reservation. Replay or fence paths that skip paid work do not re-admit.

Prod app and worker are separate containers with no shared `CLAUDE_CONFIG_DIR` (YUK-575). Cross-process
SDK resume onto the durable worker is physically impossible and is not this ticket.

## Decision

### 1. Foreground consecutive POSTs resume one Agent SDK session

Ordinary `triggered_by: chat` inline SSE turns on the same product `learning_session` resume the
previous Agent SDK session when a session id exists. They do not mint a cold CopilotTask whose only
memory is the `{role,text}` fold.

Implementation shape (capability-local, Copilot only):

- Flip Copilot's query options to `persistSession: true`.
- After a successful query, keep the SDK session id on the existing product conversation
  (`learning_session`), not on a new table.
- The next inline POST for that conversation passes `resume: <sdk_session_id>`.
- The process-memoized `CLAUDE_CONFIG_DIR` tmpdir is the session file home for v1. App process restart
  loses SDK files. Fall back to today's event fold. Do not add a volume or a new table for jsonl.
- `GET/POST /api/copilot/sessions` stay product conversations. They do not list Agent SDK sessions.

### 2. Close the previous query before the next POST. One HTTP turn is one admitted family.

Do not hold `WarmQuery` across user think-time. That would pin a YUK-842 family slot against the 90s
HTTP budget and 15s lease heartbeat.

Each inline POST still `startup()` + `query()` and still admits one family keyed by that turn's
`task_run_id`. Release on SSE close as today.

Resume is therefore a new `sdkQuery()` that reconstructs the SDK transcript. It is not a second
concurrent unpaid family sitting on top of a still-live parent. Explicit admission rules:

- Never start a resumed query while the previous Copilot query for that conversation is still acquired.
- Resume is a new family root, not a nested child. Do not set `borrowed_from_task_run_id` to the
  previous CopilotTask. Borrow remains for DomainTool descendants of the current query only.
- Do not call `sdkQuery()` twice for one POST.
- Durable `durable:true` / Mission 202 stays its own worker CopilotTask family. No SDK `resume` onto
  the worker. Job-events reconnect is unchanged.
- Teaching `skill_context` still bypasses CopilotTask.

This is the explicit YUK-842 design the ticket asked for. Resume is admitted and paid as one new session
start. It does not fork a second family for the same turn.

### 3. Product history fold remains the restart fallback, not the happy path

`assembleConversationHistory` stays. Use it when `resume` is missing, SDK files are gone, or `resume`
fails. Do not delete event-sourced turns.

### 4. Non-goals (hard)

- Do not delete the 45s `tool_operation` yield (F5 1A).
- Do not retire the ADR-0053 mailbox or native Task `tool_result` into a live parent (F5 2B). Leave
  YUK-927 / YUK-757 closed.
- No shell stay, no classifier, no generic Promise durability, no `src/server/durable-handoff/`
  (ADR-0052 NO-GO).
- No compact, token stream, `canUseTool`, Skill tool, steer, 202-off-chat, or noun collapse.
- Propose-only and claim-safety gates stay. Single persona. Teaching pack unchanged.
- Do not clone OpenCode writes.

## Consequences

- The Dock still sends `session_id` = `learning_session.id`. The Agent SDK session id is server-owned.
- Tool-loop state inside one POST is unchanged. Cross-turn model memory becomes the SDK transcript when
  resume hits, which includes tool traces the 4000-char fold currently drops.
- App restart: SDK resume misses, event fold still works, user sees a colder model until a new SDK
  session is minted.
- Mailbox continuation still starts a new logical CopilotTask after the child settles. That path does
  not pretend to resume the original HTTP query.

## Rejected alternatives

- Keep `WarmQuery` alive between POSTs. Pins admission and fights the edge idle window.
- New `copilot_sdk_session` table. The product conversation already owns reconnect identity.
- Shared volume / cross-container resume into the worker. YUK-575. Durable stays job_events.
- Treat resume as a nested borrow of the previous CopilotTask family. The previous family is released.
  Borrow is for live outer→tool→inner only.
- Delete ToolOperations or the mailbox in this ticket. Wrong invert. Owner still holds F5 1A/2B.

## Implementation notes (Backend, after this ADR)

- One cloud agent. `/poteto-mode`. Exact-head Gate on a re-verified main SHA.
- Tests: two consecutive inline `/api/copilot/chat` POSTs on one `learning_session`; second query options
  include `resume` and `persistSession: true`; one admission family per POST; fold fallback when resume
  is absent.
- Copilot-only override of `persistSession`. Other task kinds stay `false` unless a later ticket says
  otherwise.
