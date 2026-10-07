# YUK-1346 / YUK-1350 recovery after the YUK-1365 owner decision

Recovered the clean implementation tree at `c59bb7dadae9dec440b5ccbb0a0ab93478369e1c`
on `fix/yuk-1346-reconcile-safety`. Normal merge of main
`df08399ff179c5882b39da87e162237fd18246c7`, without rebase or force.
The task brief reports PR1593 was already deployed by another owner. This lane
did not inspect runtime or its locks, and does not assert a live revision.

## Actual predecessor work and the superseded P1

The cancelled predecessor had committed work despite its stale terminal summary.
`a9cf71d3dd8320db151922fcb1808412463fe48f` changed the old marker binder to require
one exact existing prompt and replace its hidden reference with the full visible
reply. `db887fe4ae44a6c2e6f101bd60f9da706f2c80b3` added protocol-consumer tests.
`75eaeb82b76acaf0d9b0447152860a2acfe5800b` and the recovery HEAD shortened that
protocol. Those changes were inspected in Git; they were not reimplemented.
The old PLAN/now claim that this gate repair was the current release requirement
has been replaced. Its earlier test counts remain historical evidence.

PR1588 discussion `4207279165` and the original parent RED log remain evidence
of a defect in the former gate. `/tmp/yuk1346-reformatted-red.log` is retained;
its digest is in the linked evidence JSON. This lane does not reply or resolve
the discussion.

The newer owner instruction explicitly retires that consumer:

> Owner decision, 2026-10-07: completely remove Copilot chat question/solution
> keyword detection and its independent learning-content review.

Source: [YUK-1365 decision](2026-10-07-yuk1365-copilot-prose-stream.md), lines 3-7;
the retained boundaries are on lines 30-45. The old P1 is therefore superseded
by that decision. The current path does not claim factual review or repair of
the old classifier. It does not reinstate a marker, replacement classifier,
hidden-answer validation, or mandatory question-generation workflow.

## Actual consumers and conflict decisions

- `copilot/manifest.ts:192` mounts the durable job, whose production handler at
  `jobs/copilot_run.ts:1627` calls `runCopilotRun`. The execution default at
  `jobs/copilot_run.ts:709` is the real `executeCopilotTurn`.
- `ai/pi-agent-adapter.ts:1328` forwards root Pi text deltas. `ai/runner.ts:628`
  dispatches them; completed frames avoid duplicate prose at line 1245.
  `copilot-execution.ts:441` filters internal comments and emits `prose_delta`.
  `copilot_run.ts:1039` serializes DELTA/STEP under the settlement lock.
- `reply-finalization.ts:357` is not the former content-review consumer. The
  current file at `finalizeTerminal` binds executed tool trace, correction,
  disclosure and presentation references, then emits receipt protocol v2.
  The whole file is byte-identical to main. The deleted content-validation
  module has no live import. The unused branch-only kernel decision schema,
  full-response solver mode, existing-answer prompt and protocol loader/tests
  were removed. Shared Practice files and the Copilot skill pack equal main.
- `copilot-execution.ts:280,373,375,499` retains the fixed six-read allowlist,
  no skills/research/remote tools, cold restricted execution and no retained
  cursor. `live-turn-context.ts:25,50` keeps private correction-policy metadata
  out of both model input forms. The obsolete validator-history copy is gone;
  eligible conversation history, replay and compaction still filter restricted
  roots before bounded selection.
- Trusted acceptance/job/root policy and cursor settlement remain in
  `derivation-policy.ts`, `durable-dispatch.ts` and `copilot_run.ts`.
  `events/events.ts:264` stamps restricted raw events as ingestion opted out.
  `memory/triggers.ts:343,853` and `memory/client.ts:369,382` reject derivation.
  Raw chat remains stored. This is not a promise to delete raw conversation.
- `memory/reconcile-llm.ts:314` retains `providerStartFence: 'operation_kind'`.
  Line 320 bounds transport by the remaining attempt deadline; line 430 clears
  the abort timer only after body processing. `direct-provider-attempt.ts:186`
  reserves the paid start. These files and the retention readers/ingest paths
  are byte-identical to the recovery HEAD. Unknown outcomes are not retried.
- A live validation consumer remains in `notes/server/tools/author-artifact.ts:175`.
  Copilot's domain-tool context calls the Practice public validator, which still
  runs strict question/solve admission and teaching checks. Official question
  authoring at `practice/server/tools/question-author.ts:256` retains the
  deterministic judge contract, and `write-quiz.ts:315` rechecks admission under
  locks. These implementations equal main. Chat gate removal does not remove
  materialization or grading admission.

## Verification and exact artifacts

[Machine evidence](evidence/2026-10-07-yuk1346-main-streaming-recovery.json) records
all commands, file lists, source comparisons and SHA256 digests. It includes
patches against both parents and the pre-recovery remote `6bb4ddb58`, the actual
predecessor log, and the original RED log. Source manifest digest covers 3134
source/config files. Thirty-one exact file comparisons preserve main streaming,
Practice admission, Pi/DBOS gate, package/lock and recovery retention/fencing.
Relative to main, the actual source/test diff has 59 files, 2637 insertions and
243 deletions. The JSON lists every path; no new UI implementation was made.

The final scoped run passed 444 unit tests in 17 files and 188 DB tests in 9
files. DB global setup started a fresh pgvector Testcontainer, migrated it and
cloned isolated fork databases. Only PATH/HOME/TMPDIR/USER/LANG were inherited;
existing DB/provider environment was excluded. Provider output/transport was
scripted or mocked. Installed Pi-loop streaming/Stop and direct-fence redelivery
are local contract evidence, not real-provider acceptance.

Frozen install, typecheck, lint, build and ten local audits passed. Lint has
297 existing warnings and no errors. The initial new streaming assertion used
the wrong test callback property, caught by both unit and typecheck. It was
corrected to `observe`, and the final checks passed; initial logs are retained.
No full local test suite or additional review was run.

Runtime revision, fresh provider/browser behavior, host-restart durability,
exact-head CI and the old timed-out request's outcome/cost are unverified here.
Old R/R2/R3/R4/A/ingest and unknown requests were not replayed. Historical
failures/DLQ, backup and restore obligations remain unchanged. Parent owns the
P1 supersession reply, new CI and runtime acceptance. PR1594 belongs to another
owner. This implementation lane commits locally, returns a clean tree and
releases its sole-writer authority without pushing.

Capture gate: no new actionable product follow-up was found. The temporary
test-wiring failure was fixed locally. Existing follow-ups remain with the
parent; this lane was explicitly prohibited from Linear access or new review.
