# ADR-0056 — Native Task `tool_result` into live parent; retire mailbox continuation

**Status:** Accepted
**Decision source:** YUK-938; Eng Lead architecture pass at main `c76cb09079997b3a9b07abf5b421830248ed1c63`
**Related:** ADR-0053 · ADR-0054 · ADR-0055 · ADR-0052 · YUK-842 · YUK-572 · YUK-575 · YUK-927 · YUK-757 · YUK-920 · YUK-837
(historical F5 2B; do not reopen)

**Supersedes:** ADR-0053 for **foreground inline Copilot** only. ADR-0053 mailbox continuation is retired on
that path; `subagent_run` noun and projection stay until B3.

## Context

Yukoval 2026-08-29 inverts F5 **2B**. ADR-0053 (YUK-932) built a durable subagent mailbox because native Agent
SDK `Task` is process-local: a child could not return `tool_result` into a still-running parent, and Copilot
launched `launch_researcher` onto pg-boss then minted a **new** `CopilotTask` via `runCopilotContinuationTask`.
That was a cold-session patch.

YUK-936 (ADR-0054) persist/resume is on main. YUK-937 (ADR-0055) deleted the 45s yield so the parent query
hangs for long safe reads. Foreground parent should now **block for the child** and write **native Task
`tool_result` keyed by `toolCallId` into the same live SDK session**. Retire mailbox auto-root continuation.
Do not clone OpenCode.

**Copy-paste trap.** ADR-0053 retired native Task *because* the parent was cold. Do not keep `launch_researcher`
+ mailbox as a parallel result channel "on top of" native Task. One result path: native `tool_result` into the
live parent. This is not HTTP handoff and not a new CopilotTask.

### How mailbox continuation works today

- `src/capabilities/copilot/server/subagent-mailbox.ts` owns `subagent_run` + `copilot_continuation`; queues
  `copilot_subagent_run`, `copilot_continuation`, `copilot_subagent_reconcile`.
- Public model interface: `launch_researcher`, `get_subagent`, `wait_subagent`, `cancel_subagent`. Copilot does
  **not** mount native SDK `Task`.
- `CopilotResearchTask` has a separate task-run/provider admission, 10-turn and 10-minute budget, read-only
  allowlist. Child completion atomically settles the row, writes `experimental:subagent_run_settled`, inserts
  one pending continuation.
- `src/capabilities/copilot/jobs/copilot_continuation.ts` + `runCopilotContinuationTask` in `copilot_run.ts`
  claim the session slot and invoke a new logical `CopilotTask` with the settled event as causal anchor. Its
  reply is a **new turn**; it does not resume or background the original HTTP request.
- ADR-0054 Consequences still say mailbox continuation is a new turn and is NOT an invert of F5 2B. ADR-0055
  Decision 3 still says do not retire mailbox. This ADR is that invert for foreground inline Copilot.

## Decision

### 1. Native Task into the live parent

Foreground inline Copilot remounts native Agent SDK `Task` (or equivalent SDK child that returns `tool_result`
keyed by `toolCallId`) so the result lands in the **still-running parent `WarmQuery` / same SDK session**.

- Parent query hangs until the child settles, same idea as ADR-0055 blocking `search_memory_facts`.
- Child `tool_result` is written by `toolCallId` into the live parent query. Not HTTP handoff. Not a new
  `CopilotTask`. Not `runCopilotContinuationTask`.
- Keep the same POST SSE open (existing 15s `: keepalive` comments).

### 2. Model surface — one result path

Retire `launch_researcher` from the **model** allowlist on foreground inline Copilot. One result path: native
Task `tool_result` keyed by `toolCallId` into the live parent query.

- Do not leave `launch_researcher` + mailbox as a parallel result path "on top of" native Task.
- Dock may still project `subagent_runs[]` from `subagent_run` rows and settlement events. That projection is
  **not** `get|wait_subagent` as the model's result channel. Owner cancellation may remain on the capability
  surface; polling controls are not how the model receives the child outcome on foreground inline chat.

### 3. Retire mailbox continuation from the foreground main path

Delete/stop the automatic `copilot_continuation` → `runCopilotContinuationTask` path for foreground inline
chat.

- Child completion must not mint a synthetic root continuation turn.
- ADR-0053 is superseded for that path. Document the supersede in both ADRs.
- After mailbox continuation is retired, `copilot_subagent_reconcile` must **not** mint a continuation on
  foreground inline chat.

### 4. One voice

Keep `forwardSubagentText: false` (YUK-572). The child lands as `tool_result` by `toolCallId`, not a second
Copilot voice in the SSE stream.

- No subagent transcript or hidden reasoning forwarded as a parallel assistant message on foreground inline
  chat.
- Dock `subagent_runs[]` projection is observability only; it is not a second reply actor.

### 5. Budget — child shares the parent family

The child shares the parent's `maxTurns` and remaining 90s HTTP provider-session budget
(`HTTP_PROVIDER_SESSION_BUDGET_MS`). Today's `CopilotResearchTask` 10-turn / 10-minute separate admission goes
away on foreground inline chat.

- Fail closed at budget. Do **not** extend `HTTP_PROVIDER_SESSION_BUDGET_MS`.
- Do not smuggle a second YUK-842 family for the child.
- If POST/90s kills the family mid-child, fence/cancel the in-flight child so ADR-0054 resume does not
  double-pay.

### 6. Keep the SubagentRuns noun until B3

Keep `subagent_run` table, started/settled events, Dock `subagent_runs[]` projection, and owner cancellation
**until B3 noun collapse**. This ticket only rips mailbox *continuation*, not the noun.

- The table remains the durable projection of the child, not a second result channel. Settlement events and
  cancellation semantics stay; only the automatic continuation job path goes away on foreground inline chat.

### 7. Admission / YUK-842

Native Task is SDK-internal (`Options.agents` / Task tool) and stays **inside the parent's already-admitted
family** (Decision 5).

- Do not mint a second `task_run_id` / `acquireProviderSession` for the child the way `CopilotResearchTask`
  does today.
- Do not treat the child as a nested DomainTool borrow of a released previous POST. One POST = one family, as
  ADR-0054.
- Reconnect is ADR-0054 resume (new `task_run_id`, charge at acquire, conversation mutex), not a mailbox
  continuation.

### 8. Durable stays explicit

- `durable:true` / Mission 202 stay worker job_events, `persistSession: false`, no SDK resume onto the worker
  (YUK-575).
- Do not mount live-parent Task onto the worker.
- If durable still needs a child, it may keep a capability-local worker child, but it must **not** reintroduce
  foreground mailbox continuation.
- Ordinary chat stays foreground.

### 9. Non-goals (hard)

- No shell, no classifier, no generic Promise durability, no `src/server/durable-handoff/` (ADR-0052).
- No compact, token stream, `canUseTool`, Skill tool, steer, 202-off-chat, noun collapse.
- Propose-only. Single persona. Teaching pack unchanged.
- Do not reopen YUK-927, YUK-757, YUK-920, YUK-837.
- Do not clone OpenCode writes.

### 10. Tests impl must rewrite

- `src/capabilities/copilot/server/subagent-mailbox.ts` and related unit/db tests (continuation path removal;
  `copilot_subagent_reconcile` must not mint continuation on foreground inline chat)
- `src/capabilities/copilot/jobs/copilot_continuation.ts` and `copilot_run.ts` (`runCopilotContinuationTask`
  foreground path)
- `src/capabilities/copilot/server/tools/subagent-controls.ts` (`launch_researcher` off model allowlist;
  `forwardSubagentText: false` unchanged)
- Foreground acceptance tests: child blocks parent; native `tool_result` in same query; no
  `copilot_continuation` job for foreground inline chat; no synthetic root continuation turn; child shares
  parent `maxTurns` and remaining 90s budget.

Foreground acceptance: a native Task child that runs to completion returns `tool_result` in the same live
parent query; `launch_researcher` is not on the model allowlist; no pending `copilot_continuation`; no new
logical CopilotTask for child result delivery; no second Copilot voice in SSE.

## Consequences

- ADR-0053 is superseded for foreground inline Copilot. Mailbox auto-root continuation is retired on that
  path.
- ADR-0054 non-goal "do not retire mailbox / native Task into live parent" is superseded for foreground inline
  Copilot by this ADR.
- ADR-0055 Decision 3 ("do not rip mailbox") is superseded for foreground inline Copilot by this ADR.
- Child result is native Task `tool_result` in the same SDK session. Parent holds the live `WarmQuery` until
  child settle or deadline. Child shares parent `maxTurns` and remaining 90s budget. Reconnect after POST
  death is ADR-0054 resume only.
- `launch_researcher` is off the foreground inline model allowlist. Dock `subagent_runs[]` remains
  observability only; `get|wait_subagent` is not the model result channel.
- `forwardSubagentText: false` stays. Child is `tool_result` by `toolCallId`, not a second Copilot voice.
- `subagent_run` noun and Dock projection remain until B3; only the mailbox continuation path goes away on
  foreground inline chat. `copilot_subagent_reconcile` must not mint continuation there.
- Durable/Mission 202 and explicit worker children are unchanged in scope; they must not reintroduce foreground
  mailbox continuation.

## Rejected alternatives

- Keep mailbox continuation alongside native Task. Two result channels; model gets duplicate or conflicting
  child outcomes.
- Keep `launch_researcher` + `get|wait_subagent` as the result path while also mounting native Task. Copy-paste
  trap from ADR-0053 cold-session rationale.
- Mint a second `task_run_id` / `CopilotResearchTask` admission for the child inside one POST. Violates one
  POST = one family (ADR-0054 / YUK-842).
- Extend `HTTP_PROVIDER_SESSION_BUDGET_MS` to cover long children. Out of scope; fail closed at budget.
- Reintroduce mailbox continuation on POST reconnect. Resume is a new admitted family, not a synthetic root
  turn.
- Retire `subagent_run` table or Dock projection in this ticket. Wrong invert; B3 noun collapse.
- Mount live-parent Task onto the durable worker. YUK-575; durable stays job_events.

## Implementation notes (Backend, after this ADR)

- One cloud agent. `/poteto-mode`. Exact-head Gate on a re-verified main SHA.
- Backend owns impl. Eng Lead does not implement in this PR.
- Remount native SDK `Task` (or equivalent) on foreground inline Copilot; block parent until child settles;
  write `tool_result` by `toolCallId` into the live query.
- Retire `launch_researcher` from foreground inline model allowlist. Keep Dock `subagent_runs[]` projection.
- Remove automatic `copilot_continuation` → `runCopilotContinuationTask` for foreground inline chat; stop
  `copilot_subagent_reconcile` from minting continuation there.
- Child shares parent `maxTurns` and remaining 90s budget; retire `CopilotResearchTask` separate admission on
  this path.
- Keep `forwardSubagentText: false`. Keep `subagent_run` noun and projection.
- Rewrite tests listed in Decision 10. Foreground acceptance above is the scoped gate.
