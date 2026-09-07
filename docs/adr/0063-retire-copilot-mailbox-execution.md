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
