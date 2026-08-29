# ADR-0055 — Delete 45s tool_operation yield; block in live SDK query

**Status:** Proposed
**Decision source:** YUK-937; Eng Lead architecture pass at main `24b84d4491b0195a0eb863b36d24863c2553c905`
**Related:** ADR-0041 · ADR-0052 · ADR-0053 · ADR-0054 · YUK-842 · YUK-575 · YUK-927 / YUK-931
(historical F5 1A; do not reopen)

## Context

Yukoval 2026-08-29 inverts F5 **1A**. ADR-0054 (YUK-936) now persists and resumes the Copilot Agent SDK
session across HTTP turns on the same `learning_session`. The 45s `tool_operation` yield was a cold-session
compromise: a long safe read would hand off HTTP, write a ToolOperations row, and let the model poll. With a
live session on the app process, foreground Copilot tools should **block inside the current SDK query**, not
yield after 45s. This is not HTTP handoff and not client poll.

**Copy-paste trap.** YUK-937 text says foreground `effect!==read` tools should block. In code those **already
block**. The yield gate today is conjunctive in `src/server/ai/tools/mcp-bridge.ts`:

`safeHandoff && effect==='read' && name!=='run_task' && sessionId`.

Production `safeHandoff` tool is only `search_memory_facts`. Invert 1A = stop yielding **safeHandoff reads**
so they block in the live query too.

### How yield works today

- `src/kernel/tools/tool-operations.ts` exports `SAFE_TOOL_OPERATION_YIELD_MS = 45_000`, the default
  `yieldAfterMs` in `executeSafeToolOperation`.
- `ToolOperations.start` inserts `tool_operation` immediately. `wait(45s)` either settles or
  `writeYieldedEvent` and returns `{ kind: 'yielded' }` **to the model inside the same**
  `WarmQuery.query()` / same `task_run_id`.
- The model then calls `get_tool_operation` / `wait_tool_operation` (cap 5s) / `cancel_tool_operation`.
  Client SSE does **not** poll. Dock projects `tool_operations[]` from events.
- Yield does not close the SDK query. It does not mint a new CopilotTask. It is orthogonal to ADR-0054
  cross-POST persist/resume.

## Decision

### 1. Hang the live query; resume is reconnect, not a second yield machine

Foreground inline `executeSafeToolOperation` waits for settlement (or `hard_deadline_exceeded`). Never return
`{ kind: 'yielded' }` to the model on this path.

- Keep the same POST SSE open (existing 15s `: keepalive` comments).
- Do **not** extend the 90s HTTP provider-session budget (`HTTP_PROVIDER_SESSION_BUDGET_MS` in
  `src/kernel/http.ts`) in this ticket. A read that overruns remaining budget fails closed via existing
  `hard_deadline_exceeded`.
- If cloudflared/~100s idle or the 90s budget kills the POST: close/release that YUK-842 family. When that
  kill happens mid-`search_memory_facts` (or any remaining safeHandoff read), fence/cancel the in-flight
  `tool_operation` so the next ADR-0054 resume does **not** double-pay the embedding. Do **not** reintroduce
  `{ kind: 'yielded' }` as the reconnect path. The next POST uses ADR-0054 `resume` of
  `learning_session.agent_sdk_session_id` (new `task_run_id`, charge at acquire, conversation mutex, omit fold
  on resume hit). Resume is still a new admitted family, not ToolOperations yield.
- `persistSession` remains chat.ts-owned `sdkSession`, never `kind==='CopilotTask'`.

### 2. Durable stays explicit, but also stop yielding

- `durable:true` / Mission 202 stay worker job_events, `persistSession: false`, no SDK resume onto the worker
  (ADR-0054 / YUK-575).
- Disable the 45s yield on Copilot's MCP server for durable too (same kernel default is the yield; worker has
  12min and does not need the cold-HTTP compromise). Still not a mailbox invert.

### 3. Keep the noun; do not rip mailbox

- Keep `tool_operation` table, leases, yielded/settled events, Dock `tool_operations[]` projection, and
  `get/wait/cancel_tool_operation` **until B3 noun collapse**. This ticket only deletes the yield *path* (no
  `{kind:'yielded'}` to the model).
- Do **not** retire ADR-0053 mailbox / `launch_researcher` / `get|wait|cancel_subagent` /
  `runCopilotContinuationTask`. That is YUK-938, blocked on this ADR+impl merge.
- No `src/server/durable-handoff/` (ADR-0052). No shell, classifier, compact, token stream, `canUseTool`,
  Skill tool, steer, 202-off-chat, noun collapse. Propose-only. Single persona. Teaching pack unchanged.

### 4. Tests impl must rewrite

- `src/capabilities/copilot/server/safe-tool-handoff.unit.test.ts` (exact 45s boundary / handle after 45s)
- `src/server/ai/tools/mcp-bridge.test.ts` and `mcp-bridge.integration.test.ts`
- `src/kernel/tools/tool-operations.unit.test.ts` / `.db.test.ts` (yielded events)
- `src/capabilities/copilot/jobs/copilot_run.test.ts` (`onSafeOperationRunning`)
- `src/capabilities/copilot/server/turns.db.test.ts` (yielded/settled projection)

Foreground acceptance: a `search_memory_facts` call that runs >45s still returns a settled MCP result in the
same query; no `tool_operation_yielded` event; no yielded handle in the model tool result.

## Consequences

- ADR-0054 non-goal "do not delete the 45s yield" is superseded for foreground inline Copilot by this ADR.
- Long safe reads hold the live `WarmQuery` and the POST SSE until settle or `hard_deadline_exceeded`.
  Reconnect after POST death is ADR-0054 resume only.
- ToolOperations noun, control tools, and Dock projection remain for mailbox/B3; only the 45s early-return path
  goes away.
- YUK-938 (mailbox / native Task `tool_result` invert) stays blocked until this ADR merges and impl lands.

## Rejected alternatives

- Keep 45s yield alongside ADR-0054 resume. Two reconnect stories; model still polls after 45s inside one
  query.
- Client SSE poll for tool settlement. Yield was always model-side `get/wait_tool_operation`, not Dock poll.
- Extend `HTTP_PROVIDER_SESSION_BUDGET_MS` to cover long reads. Out of scope; fail closed at budget.
- Reintroduce yield on POST reconnect. Resume is a new admitted family, not a second yield machine.
- Retire ToolOperations or ADR-0053 mailbox in this ticket. Wrong invert; YUK-938.

## Implementation notes (Backend, after this ADR)

- One cloud agent. `/poteto-mode`. Exact-head Gate on a re-verified main SHA.
- Backend owns impl. Eng Lead does not implement in this PR.
- Remove `{ kind: 'yielded' }` return from foreground inline `executeSafeToolOperation` path; block until
  settle or deadline.
- Disable yield on durable Copilot MCP server (same kernel default).
- Rewrite tests listed in pin 4. Foreground acceptance above is the scoped gate.
