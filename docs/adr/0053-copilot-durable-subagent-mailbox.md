# ADR-0053 — Copilot durable subagent mailbox

**Status:** Accepted
**Decision source:** owner choice 2B; YUK-932
**Related:** ADR-0051 · ADR-0052 · YUK-927 · YUK-928 · YUK-929 · YUK-931

## Context

The foreground Copilot sometimes needs one bounded, read-only investigation that should outlive the
original HTTP turn. Native Agent SDK `Task` mounting keeps the child process-local and makes its
transcript the private return channel to the still-running parent. That cannot provide a durable result
mailbox, restart recovery, owner cancellation, or a one-shot continuation after the foreground root has
already replied.

This is distinct from a long DomainTool operation and from an explicitly durable whole-root request.
Reusing either identity would merge different idempotency, provider-fence, cancellation, and causal
event semantics.

## Decision

Copilot owns two tables and their complete protocol:

- `subagent_run` is keyed by `(session_id, parent_turn_event_id, launch_key)`. The launch key binds a
  canonical objective digest. `parent_task_run_id` is audit-only; there is no `copilot_run_id`.
- `copilot_continuation` is one-to-one with a settled child. A partial unique index permits only one
  running continuation per session.

The public model interface is four owner-local DomainTools:
`launch_researcher`, `get_subagent`, `wait_subagent`, and `cancel_subagent`. Copilot no longer mounts a
native SDK `Task`; the global spawn contract remains available to other owners.

The fixed `CopilotResearchTask` has a separate task-run/provider admission, a 10-turn and 10-minute
budget, and an explicit read-only allowlist. It cannot call `Task`, `run_task`, proposal/write tools, or
the researcher controls. Its objective and tool results are untrusted data, and no transcript or hidden
reasoning is persisted or returned.

Child completion atomically settles the row, writes one
`experimental:subagent_run_settled` event caused by its typed started event, and inserts one pending
continuation. A continuation waits for the original root reply, claims the session slot, then invokes a
new logical `CopilotTask` with the settled event as its causal anchor. Its reply is written by the root
Copilot actor and is caused by the result event. The continuation tool surface excludes
`launch_researcher`, so the automatic turn cannot recurse.

Provider execution is fenced before each paid call. A live owner heartbeats its lease. Restart recovery
may redispatch queued work, but an expired running owner becomes `lost`; it is never blindly retried.
Stable row, event, continuation, job, and reply identities plus transactional settlement prevent duplicate
materialization.

Queued cancellation settles directly. Running model/system/user cancellation is cooperative and only
becomes `cancelled` after the provider/tool loop confirms the abort; an unconfirmed expired owner becomes
`lost`. Cancelling a durable root marks its owned children for the same drain.

## Consequences

- The original root remains foreground. Child completion creates a new turn; it does not resume or
  background the original HTTP request.
- `tool_operation`, `tool_call_log`, `copilot_run`, Cloud/Mission surfaces, and generic Promise redrive
  remain unchanged and semantically separate.
- Mailbox/claim rows are operational restore fences and are wipe-only archive exclusions. Ordinary
  process restart preserves them and the minute reconciler rediscovers queued or expired obligations.
- The protocol stays capability-local under ADR-0052; it does not reopen a generic durable-handoff core.

## Rejected alternatives

- SDK native background Task: process-local ownership and no durable continuation fence.
- Reusing ToolOperations: wrong identity, result, cancellation, and side-effect semantics.
- Reusing `copilot_run`: would falsely make the child a whole user-facing root request.
- Generic callback/redrive shell: cannot express the provider-start fence, causal event chain, or
  one-running-continuation-per-session invariant.
