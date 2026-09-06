# Copilot execution ownership — YUK-954

The foreground chat and durable job now call one Copilot execution owner.
It owns learning-content validation, DomainTool/MCP permissions and correlation,
native-child configuration, cancellation propagation, session prompt compilation,
proposal-flow hooks and terminal trace finalization. Callers keep their distinct
transport, persistence, resume cursor and durable settlement/recovery responsibilities.

Foreground retains the configured latency budget and SDK session resume. Durable
retains 24 iterations / 60 tools / 12 minutes and polling/drain/fence semantics.
No caller accepts or assembles generic SDK hooks or MCP option bags anymore.
The internal test adapter is not a product caller contract.

Implementation source plus relevant tests decreased by 429 lines. Tests moved to
the shared execution seam instead of keeping two copies of SDK assembly assertions.
The author ran 119 unit and 75 DB cases; independent review ran 83 unit and 73 DB
cases and approved with no P0/P1. Cancellation after root SDK return remains
bridged through the runner's shared lifecycle controller; no additional model pass
was introduced.

## Actual outputs

At clean revision `2894ceeaab39010132a0c3a418371f951e826176`, the two named synthetic
regressions passed against Xiaomi mimo-v2.5-pro:

- Semantic: unsafe emitted teaching text rejected through QuizVerify, SolutionGenerate,
  TeachingQuality and SemanticJudge. Only the safe final reply was delivered.
  Reported cost $0.076105.
- Native child: one synchronous child succeeded with no detached continuation;
  terminal root reply and trace receipt matched. Reported cost $0.070271.

Inputs, outputs, digests, task-run IDs and provider costs are sealed in
`evidence/2026-09-06-copilot-execution-actual.json`. Added spend is $0.146376;
the incremental allowance has $0.604828 remaining. Prior interrupted-call costs
remain unknown. This is not a production test or durable queue E2E.

Subsequent integration combines the already-reviewed Goal/Knowledge changes and
tightens the dependency baseline to 443/0/47; it does not change this executor's code.
Exact-head CI is still required before merge. No UI or deployment is included.
