---
status: accepted
---

# Retire the drained Copilot mailbox execution path

ADR-0062 makes every Copilot message part of one persistent conversation; therefore
ADR-0056's foreground-only exception and separate durable worker child no longer
apply. After a deployed full drain window, remove the old mailbox researcher,
automatic root continuation, their queues' handlers and standalone ResearchTask.
Native child results return inside their original parent; missing terminals follow
the committed parent outcome, never a new paid root invocation.

Keep the existing native child projection, cancellation, historical rows/events and
live conversation readers. ToolOperations remains the internal owner of real remote
tool execution; it is not a second Copilot conversation or a Mission product surface.
This decision retires redundant execution, not every historical SQL/wire name; it
does not invent a generic task framework or claim a physical table/name collapse.

Each installation must prove its old work drained. A read-only fatal migrate guard
refuses pending legacy children/continuations/jobs or the old reconcile schedule,
while allowing terminal history and running native projections. Stop old writers,
unschedule the exact retired cron and drain its housekeeping ticks before upgrading;
do not discard jobs to make the guard pass. Rollback uses the prior worker and kept
schema/history; restarting that worker restores its old schedule, so repeat readiness
before another upgrade. Mac authorization does not authorize a NAS deployment.

## Final retained-name disposition (2026-09-08)

The product vocabulary is a persistent conversation, its accepted turns, native
children and tool calls. There is no separate foreground/background conversation
or Mission surface (ADR-0062). Do not collapse these different responsibilities
into a generic task table merely to reduce the number of names.

- `subagent_run` is the current native-child lifecycle projection as well as a
  historical record. Preserve same-parent settlement, explicit Stop, terminal
  recovery and turn readers. Its retained physical name does not authorize the
  deleted mailbox launcher or automatic paid continuation.
- ToolOperations owns real remote tool execution and its lease, cancellation and
  terminal audit. It is not a second agent or conversation. Preserve this owner
  and `tool_operation`; folding it into child execution would mix tool leases
  with SDK child lifecycle rules.
- `copilot_continuation` is retained historical schema, export and installation
  readiness evidence, not a current execution mechanism. No new producer or
  worker handler is permitted by this retention decision.

Physical SQL, historical event and wire names are deliberately retained, not an
unfinished universal rename. Deletion would require an independently justified
data-retention/migration decision across installations; the Mac drain evidence
does not authorize deleting another installation's pending work. This closes the
noun-disposition decision without claiming a physical schema collapse or complete
provider/learning-workflow acceptance.
