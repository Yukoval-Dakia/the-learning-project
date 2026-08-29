# ADR-0054 - Persist and resume Copilot Agent SDK session across HTTP turns

**Status:** Proposed
**Decision source:** YUK-936; Eng Lead architecture pass at main `2b22d5d70d46f487592f6966a9b7ad980e3bd40e`
**Related:** ADR-0041 · ADR-0051 · ADR-0052 · ADR-0053 (F5 2B) · YUK-842 · YUK-575 · YUK-927 (F5 1A;
`PLAN.md`; do not reopen)

## Context

OpenCode and Claude Code own a live session. The server persists the user message, runs the tool loop,
and exits when the turn is finished. HTTP is a client.

TLP Copilot does the opposite. `POST /api/copilot/chat` mints a cold `CopilotTask` every time
(`src/capabilities/copilot/server/chat.ts` then `streamTaskCollecting`). `src/server/ai/runner.ts`
`buildQueryOptions` hardcodes `persistSession: false` for every task kind and never passes `resume`.
`docs/audit/2026-06-05-agent-sdk-alignment.md` still treats that as a red line. This ADR is the
Copilot-foreground supersede of that red line for ordinary inline chat only.
Continuity is a Postgres `learning_session` plus a bounded `{role,text}` fold
(`assembleConversationHistory`, 8 turns × 800 chars, 4000 total) stuffed into
`JSON.stringify(CopilotRunInput)`. The Agent SDK session id is discarded.

That HTTP-request machine is why F5 invented ToolOperations (45s yield, YUK-927 / `PLAN.md`) and the
ADR-0053 mailbox instead of blocking tools and returning native Task results into a live parent. F5 1A
is documented and is not deletable. This ADR unlocks live-session resume for ordinary foreground chat.
It does not delete those F5 mechanisms.

YUK-842 admits a complete `startup()` + `WarmQuery.query()` family, not an HTTP request. A nested
same-lane DomainTool may borrow the parent family slot. A parallel sibling may not. Each child still
takes a start-reservation. Replay or fence paths that skip paid work do not re-admit.

Prod app and worker are separate containers with no shared `CLAUDE_CONFIG_DIR` (YUK-575). Cross-process
SDK resume onto the durable worker is physically impossible and is not this ticket.

## Decision

### 1. Foreground consecutive POSTs resume one Agent SDK session

Foreground inline SSE turns on the same product `learning_session` resume the previous Agent SDK
session when a session id exists. That includes ordinary chat and chip-trigger on the same
`learning_session`. They do not mint a cold CopilotTask whose only memory is the `{role,text}` fold.

Implementation shape (capability-local, foreground inline Copilot only):

- Enable `persistSession: true` and store or resume the SDK id only for **foreground inline** Copilot
  chat on the app process (ordinary `/api/copilot/chat` SSE, not a 202 worker job).
- Do **not** key the override on `kind === 'CopilotTask'`. Durable/Mission 202 uses the same kind with
  `budgetOverride`. A kind-only override would persist on the worker tmpdir and write that SDK id onto
  `learning_session`, poisoning app resume.
- `buildQueryOptions` sets `persistSession: false` runner-global today. Do not silently persist
  Attribution, NoteGenerate, or other task kinds.
- Durable `durable:true` / Mission 202 stays `persistSession: false`. No SDK session id written from
  the worker onto `learning_session`.
- `CopilotCorrectionIntentTask` stays `persistSession: false`.
- Teaching `skill_context` still bypasses CopilotTask.
- After a successful query, keep the SDK session id on the existing product conversation
  (`learning_session`), not on a new table.
- The next inline POST for that conversation passes `resume: <sdk_session_id>`.
- The process-memoized `CLAUDE_CONFIG_DIR` tmpdir is the session file home for v1. App process restart
  loses SDK files. Fall back to today's event fold. Do not add a volume or a new table for jsonl.
- `GET/POST /api/copilot/sessions` stay product conversations. They do not list Agent SDK sessions.

### 2. Close the previous query before the next POST. One HTTP turn is one admitted family.

Do not hold `WarmQuery` across user think-time. That would pin a YUK-842 family slot against the 90s
HTTP budget and 15s lease heartbeat.

The admitted unit is one `startup()` plus one `WarmQuery.query()`. `withPreparedSdkQuery` calls
`query()` once then closes. Each inline POST still admits one family keyed by that turn's
`task_run_id`. Release on SSE close as today.

Resume is therefore a new `sdkQuery()` that reconstructs the SDK transcript. It is not a second
concurrent unpaid family sitting on top of a still-live parent. Explicit admission rules:

- `task_run_id` is single-use. Resume MUST mint a new `task_run_id` and go through
  `acquireProviderSession`. Do not reopen a released or terminal admission row. Duplicate-id fails
  closed.
- Charge is at acquire, not at `query()`. Skipping acquire because "the previous turn already paid"
  is the unpaid fork. The previous family is released. The next HTTP turn is a new root.
- Never start a resumed query while the previous Copilot query for that conversation is still acquired.
- Resume is a new family root, not a nested child. Do not set `borrowed_from_task_run_id` to the
  previous CopilotTask. Borrow (`parentTaskRunId`) is concurrency-only for a still-acquired parent
  DomainTool descendant. It still burns start-reservation. Do not borrow the previous CopilotTask after
  it has released.
- `forkSession` is a parallel branch. It takes another concurrent slot and a start reservation. It is
  not free continuation.
- SDK-internal retries, `maxTurns`, and `Options.agents` stay inside one family. Loom and pg-boss
  retries are new families.
- Do not call `sdkQuery()` twice for one POST.
- Durable `durable:true` / Mission 202 stays its own worker CopilotTask family. No SDK `resume` onto
  the worker. Job-events reconnect is unchanged.

This is the explicit YUK-842 design the ticket asked for. Resume is admitted and paid as one new session
start. It does not fork a second family for the same turn.

### 3. Product history fold remains the restart fallback, not the happy path

`assembleConversationHistory` stays. On a resume **hit**, omit it from `CopilotRunInput`. Passing
`resume` plus the 8×800 fold double-stuffs the model. Use the fold only on miss, fail, or restart (no
stored id, SDK files gone, or `resume` throws). Do not delete event-sourced turns.

### 4. Non-goals (hard)

- Do not delete the 45s `tool_operation` yield (F5 1A, YUK-927 / `PLAN.md`).
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
- Mailbox continuation (`runCopilotContinuationTask`) stays a new logical CopilotTask after the child
  settles (ADR-0053: new turn, does not resume or background the original HTTP request). A later optional
  pass of the stored SDK session id into that new turn is still mailbox-triggered, still a new admitted
  query, and is NOT an invert of F5 2B. Do not collapse it to native Task `tool_result`.

## Rejected alternatives

- Keep `WarmQuery` alive between POSTs. Pins admission and fights the edge idle window.
- New `copilot_sdk_session` table. The product conversation already owns reconnect identity.
- Shared volume / cross-container resume into the worker. YUK-575. Durable stays job_events.
- Treat resume as a nested borrow of the previous CopilotTask family. The previous family is released.
  Borrow is for live outer→tool→inner only.
- Add `persistSession` plus `resume` on top of today's fold without going through acquire. That is the
  unpaid hole. The ticket still requires SDK resume. It must be option 3 from the investigation (new
  `startup()` + `query(resume:id)`, new `task_run_id`, admitted).
- Delete ToolOperations or the mailbox in this ticket. Wrong invert. Owner still holds F5 1A/2B.

## Implementation notes (Backend, after this ADR)

- One cloud agent. `/poteto-mode`. Exact-head Gate on a re-verified main SHA.
- Gate `persistSession: true` on foreground inline `/api/copilot/chat` on the app process. Do not key
  on `kind === 'CopilotTask'`. Durable/202 and `CopilotCorrectionIntentTask` stay `false`.
- Conversation mutex: YUK-842 slots are provider-concurrency, not per-`learning_session`. "Never start a
  resumed query while the previous Copilot query for that conversation is still acquired" needs a
  conversation-level mutex, not just admission slots.
- Resume-fail: clear the stored SDK id and mint a new session. Do not retry a dead id.
- Tests: two consecutive inline `/api/copilot/chat` POSTs on one `learning_session`; second POST on
  resume hit must have `resume` and `persistSession: true` and must **not** include the fold in
  `CopilotRunInput`; one admission family per POST; fold fallback when resume is absent. Durable/202
  and correction-intent kinds must stay `persistSession: false`.
