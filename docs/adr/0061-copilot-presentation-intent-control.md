# Copilot presentation intent is an explicit control, not reply syntax

The owner chose the full-capability option on 2026-09-06: allow an optional short
tool interaction after observing results so the agent can nominate a deliverable.
This supersedes only the YUK-939 prohibition on new MCP tools/rounds for presentation;
root terminal output remains Markdown, and the current execution budgets stay fixed.

Copilot contributes `present_primary_view` through its existing manifest. It is a
local presentation control, not a read, proposal or domain mutation. The server
validates the nomination against successful root trace, live artifact ownership
and existing HTML/content gates before publishing the existing primary-view DTO.
Tool-result, persisted-artifact and ephemeral-HTML sources are all retained.
Inline, durable live delivery and replay publish the same final product state.

Reply-tail HTML comments are no longer a model contract. Inferring intent from a
tool name/effect is rejected: the same read can be a process step or the requested
deliverable. Pre-nominating only before results arrive would lose that capability.
No private MCP registration, evaluator model, new generic harness, budget increase,
or production UI redesign is authorized by this decision.
