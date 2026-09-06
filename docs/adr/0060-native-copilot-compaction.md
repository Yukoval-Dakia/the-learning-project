# ADR-0060: Native Copilot compaction remains in one live session

## Decision

Copilot foreground live sessions explicitly enable the Claude Agent SDK's
native `autoCompactEnabled` and disable precomputed compaction through SDK
`Options.settings`. The runner adds `SessionStart(source=compact)` after
the caller's existing hooks. The compact-start hook reintroduces only the current
bounded `TurnContext`; it does not replay history, TaskSpec, skill text, raw
summary, or chain-of-thought. Learner state is injected on every Copilot turn;
proposal feedback retains digest-based delivery policy. This replaces only the
learner-state omission policy in ADR-0057; history is still never replayed on resume.

The existing permission, deadline, row/tool budgets, and six-iteration inline
ceiling remain unchanged. Compaction is context management, not a budget reset
or a way around cancellation, tool, or iteration limits. `compact_boundary`
messages feed the existing attempt usage log with a bounded count and last
trigger/pre/post context-token metadata. Billable usage is not reduced by these
context counts; neither raw summaries nor message IDs are persisted here.

## Consequences

Native SDK behavior is exercised only by the Copilot live-session path; normal
tasks do not receive these options or hooks. A successful terminal result is
still required, and a failed compaction cannot be interpreted as success or as
a new session. Offline loopback protocol evidence proves hook ordering and
same-session wiring only; it does not establish real-model summary quality or
production cost savings.
