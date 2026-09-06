# ADR-0060: Native Copilot compaction remains in one live session

## Decision

Copilot foreground live sessions explicitly enable the Claude Agent SDK's
native `autoCompactEnabled` and disable precomputed compaction. The runner
adds `PreCompact`, `PostCompact`, and `SessionStart(source=compact)` hooks to
the existing hook seam. The compact-start hook reintroduces only the current
bounded `TurnContext`; it does not replay history, TaskSpec, skill text, raw
summary, or chain-of-thought. Learner state is injected on every Copilot turn;
proposal feedback may continue to use digest-based delivery policy.

The existing permission, deadline, row/tool budgets, and six-iteration inline
ceiling remain unchanged. Compaction is context management, not a budget reset
or a way around cancellation, tool, or iteration limits. Boundary observation
records only safe phase/trigger/source metadata through the existing activity
observer seam.

## Consequences

Native SDK behavior is exercised only by the Copilot live-session path; normal
tasks do not receive these options or hooks. A successful terminal result is
still required, and a failed compaction cannot be interpreted as success or as
a new session. Offline loopback protocol evidence proves hook ordering and
same-session wiring only; it does not establish real-model summary quality or
production cost savings.
