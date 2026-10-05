# AI pipeline finalization and legacy convergence

**Decision:** finalize exact SDK terminal Markdown once in the Copilot capability.
Delete the two post-root evidence-review TaskKinds and their ledger/checkpoint runtime.
Keep question/solve/teaching semantic validators and deterministic proposal/correction gates.

Owner goal: low tokens, maintainable ownership and advanced agents. Grounded base: `090e882c`.
No UI redesign, deployment, production data deletion, generic framework or whole-project re-layout.

## Evidence-driven decisions

A private `finalize_reply` MCP tool was rejected before merge: its result normally requires another
model turn and repeats the root context even for ordinary replies.

A model-authored terminal JSON envelope was then implemented and tested. Two real read attempts
returned correct content but failed its transport contract: first prose plus duplicate fenced JSON,
then prose only despite a stronger final prompt. The first narrow decoder did not solve the second.
Known costs: $0.103107 + $0.091226. Neither is an accepted end-to-end read.

Requiring model-declared source IDs adds no factual-entailment guarantee to a structural receipt.
The final decision therefore removes that model protocol entirely: plain terminal Markdown is the
explicit contract, NOT a fallback that silently constructs missing model attestations. There is no
private finalizer tool, paid repair chain, or parallel raw/JSON implementation.

## Interface and ownership

The collecting runner exposes neutral `terminalText` from SDK success `result`, separately from
accumulated `text` and streaming deltas. Copilot uses only terminalText, never concatenated preambles
or child prose. Non-streaming runTask already returns exact terminal text.

`reply-finalization.ts` owns trace hooks, DomainTool observations and `finalizeTerminal`:
- Accept bounded non-empty terminal Markdown (64,000 characters).
- Record actual SDK tool-use IDs, root/child identity, ordinal, effect, input/output hashes and status.
- Require a closed, stable trace; in-flight or validation-time mutations fail closed.
- Compute successful root IDs as `observed_completed_tool_use_ids` on the server. Failed calls stay in
  the trace digest and proposal disclosure; they are never claimed as successful observed calls.
- Apply server-bound correction, canonical proposal disclosure, presentation normalization and the
  existing learning-content semantic validators.
- Hash candidate/final bytes as exact UTF-8; use canonical JSON hashing only for structured trace.
- Persist one prepared reply and immutable receipt; stream only those persisted bytes.
- Missing/invalid terminal content returns fixed server failure text. Durable invalid finalization
  projects FAILED rather than DONE; redelivery reuses the marker without another paid root.
- A blocked learning-content answer is a separate safe fallback policy, not a structural success claim
  about the rejected lesson.

Receipt assurance is `execution_trace_bound`: exact bytes and execution provenance, NOT factual support,
request completeness, or proof of what the model relied on. Dedicated question, solution and teaching
validators retain their semantic role. Historical `evidence_validation` payloads remain readable.

If normalization changes candidate bytes, invalidate the foreground SDK cursor; the next turn cold-loads
the actual persisted user-visible history. No same-request retry. Validators retain parent audit,
cancellation and the original absolute deadline; root provider lease is released before validation.

## Execution boundaries and retirement

- Capability-owned ModelTasks, foreground live sessions, and explicit durable Missions remain distinct.
- Root and Mission use native read-only depth-1 Task; results return to the same parent. No recursive,
  background or write-capable child. SDK bypassPermissions skips canUseTool, so PreToolUse plus actual
  callback/tool inventory enforce safety.
- `generate_goal_outline` and `generate_question_candidate` replace generic run_task through existing
  Agency/Practice runtime ports. They generate only, never write drafts or proposals.
- search_memory_facts blocks directly; no new ToolOperations producer.
- Seven legacy operation/mailbox controls are removed from actual manifests and MCP inventory.
- Preserve historical tables, migrations, task rows, replay, cancellation and pending queue recovery.
  Drain-only handler retirement requires deployed zero nonterminal rows AND zero queued/active jobs
  through the maximum deadline/retry window. Deployment is a separate authorization.
- Retain the realistic A01/A03/A04/C01/C04 trace fixture; retire tests solely for deleted reviewer internals.
- Product skills must use only the isolated config mirror, never checkout developer instructions/hooks.

## Acceptance

Scoped tests cover plain/read/correction/proposal/learning/presentation; root versus child observed IDs;
failed/in-flight/late trace; exact hashes; cancellation, recovery and idempotency; and native same-parent
results. No local full test run. Require typecheck/lint/audits/build, independent review and exact-head CI.

Actual-provider acceptance records exact revision, synthetic input/output/terminal digests, run IDs,
provider/model, tokens and costs. Compare identical synthetic read requests. Old baseline is a lower
bound (57,817 input / 2,457 output / $0.201614) because its comparator timed out with unknown cost.
The separately approved new campaign is $2 total; stop on unknown costs and track cumulative spend.
Direct durable handler tests are not queue E2E. No production savings claim from a synthetic sample.
