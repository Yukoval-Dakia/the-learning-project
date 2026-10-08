# YUK-1365: stream Copilot prose without a chat content gate

Owner decision, 2026-10-07: completely remove Copilot chat question/solution
keyword detection and its independent learning-content review. Do not add a
greeting whitelist or replacement classifier. Generated learning prose can be
shown directly, without `copilot_learning_content` or an independent reviewer.
The owner also requires genuine streamed prose.

## Execution contract

- The installed Pi root loop emits provider `message_update/text_delta` events.
  The adapter forwards those as `text_delta` frames immediately. Thinking,
  tool-call argument fragments and nested-agent prose do not enter this channel.
- A completed assistant frame still records usage and tools once. Its
  `text_streamed` flag prevents a duplicate full-message append. Legacy adapters
  or offline fixtures without partial frames use the completed text fallback.
- The execution owner removes protocol HTML comments incrementally, including
  split delimiters and JSON strings containing HTML comments or `-->`. It does
  not interpret learning content or classify user questions. This also hides
  legacy protocol comments in the authoritative terminal reply.
- The durable job owner serializes prose DELTA and STEP events. Each write shares
  the settlement lock with Stop and terminal projection, and refuses to append
  after cancellation, a domain outcome marker or a terminal event. Disconnecting
  a subscriber does not stop execution.
- Terminal REPLY/FAILED is authoritative and replaces the provisional text.
  Recovery repairs only that terminal suffix; it never re-emits the whole reply
  as a DELTA. Existing event IDs, SSE Last-Event-ID replay and the pure UI reducer
  continue to deduplicate reconnects.

## Boundaries retained

Question generation/authoring and other materializing tools retain their domain
validation, cancellation, authorization and logging. The finalizer still binds
actual tool results to presentation nominations, rejects incomplete/changing
traces, resolves live artifact references, composes proposal truth and enforces
deterministic correction contracts. HTML presentation security remains in the
existing renderer/contract. No UI implementation changes were needed.
The prompt change only removes the mandatory chat marker/reviewer requirement;
it does not introduce proactive structured-question tool calls. The parallel
owner lane owns question-to-presentation/answer behavior gaps.

Receipt protocol v2 removes `learning_content`; it records execution trace
binding, not factual correctness. Previously persisted replies/receipts remain
historical data. Recovery does not parse their receipt to regenerate content;
legacy `durable_emit_reviewed_delta` flags are ignored. There is no DB migration.
Retention policy, causal history readers and bounded model history filtering are
unchanged. The unused validator-only history copy was removed.

## Evidence and remaining acceptance

The offline DB regression runs the actual installed Pi agentLoop, runner,
execution owner, finalizer, real domain tool bridge and durable job writer.
Only provider events are scripted. It pauses before message_end, verifies a
committed provisional delta, then covers two real read-tool calls, a second
model turn, authoritative replacement, duplicated replay and redelivery. Its
Stop branch verifies provider abort and no late delta after the durable cancel.
This proves the local contract, not real-provider timing or browser acceptance.

Exact scoped commands, results and changed files are recorded in
[local evidence](evidence/2026-10-07-yuk1365-local-checks.md); the writer handoff is
in `.remember/now.md`.
Parent owns independent review, Linear capture/status, commits, PR/exact-head CI
and real acceptance/deployment. This implementation tree is not deployed.

Delta/STEP visibility is best-effort if a write fails. The authoritative outcome
still replaces the draft; the paid run is not repeated to recover a missing
increment. These tests do not establish durability across host restart.
