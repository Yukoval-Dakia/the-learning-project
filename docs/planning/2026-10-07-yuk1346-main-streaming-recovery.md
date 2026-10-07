# YUK-1346 / YUK-1350 recovery after the YUK-1365 owner decision

Recovered the clean implementation tree at `c59bb7dadae9dec440b5ccbb0a0ab93478369e1c`
on `fix/yuk-1346-reconcile-safety`. Normal merge of main
`df08399ff179c5882b39da87e162237fd18246c7`, without rebase or force.
The first merge is `6cce7fe40971d98049f3e250d7614183fa9b8f92`. During verification,
main advanced to `6e54da8dfb371887e5d6cd4076d1ff9cd7713beb` with the other
owner's landed PR1594 listener follow-up. A second normal merge incorporates
that commit; no listener implementation was authored here.
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

## First merge verification and exact artifacts

[Machine evidence](evidence/2026-10-07-yuk1346-main-streaming-recovery.json) records
all commands, file lists, source comparisons and SHA256 digests. It includes
patches against both parents and the pre-recovery remote `6bb4ddb58`, the actual
predecessor log, and the original RED log. Source manifest digest covers 3134
source/config files. Thirty-one exact file comparisons preserve main streaming,
Practice admission, Pi/DBOS gate, package/lock and recovery retention/fencing.
Relative to main, the actual source/test diff has 59 files, 2637 insertions and
243 deletions. The JSON lists every path; no new UI implementation was made.

The df08399ff merge scoped run passed 444 unit tests in 17 files and 188 DB tests in 9
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
P1 supersession reply, new CI and runtime acceptance. PR1594 implementation and runtime acceptance belong to the other
owner; this lane only integrates its landed main commit. This implementation lane commits locally, returns a clean tree and
releases its sole-writer authority without pushing.

Capture gate: no new actionable product follow-up was found. The temporary
test-wiring failure was fixed locally. Existing follow-ups remain with the
parent; this lane was explicitly prohibited from Linear access or new review.


## Final verification after the landed listener follow-up

The second merge changes only `server/index.ts` and its existing unit suite
among the 3134 source/config files hashed for the first verification. Its API
startup/shutdown, CI PostgreSQL service and usability docs are byte-identical to
main `6e54da8df`. All 31 first-merge source comparisons still hold; five more
exact comparisons cover the landed follow-up. `server/index.ts:144` starts the
existing job-events LISTEN loop before HTTP serve; shutdown stops it before
closing the DB. These unit fixtures mock HTTP, LISTEN and DB. No real API or
worker was started by this lane.

[Final machine evidence](evidence/2026-10-07-yuk1346-main-streaming-recovery-final.json)
records the second merge parents, 36 exact comparisons, updated source manifest,
patches against recovery/first-merge/latest-main, fresh log hashes and final
commands. Final verification passed 451 unit tests in 18 files, 188 DB tests in
9 new disposable Testcontainers files, typecheck, lint, build and the same ten
audits. Counts from the two runs overlap and must not be added. Evidence JSON
formatting was corrected after the first documentation lint; that failure log
is retained. Runtime/provider/browser/CI and unknown-result limitations above
still apply. No runtime lock or other owner worktree was touched.

Final documentation lint log: `/tmp/yuk1346-recovery-listen-ceaxnml2/final-document-lint.log`, SHA256 `347f8652750eccc5bcdd9db78bcb2da127b5d13438f5aadcf2ff2706c83af9d4`.

## 2026-10-08 fetched-main probe integration

Normal merge of fetched main `5aa2a9e989984dfa065b3ba400b67b6b987b12e3`
into clean lane HEAD `31098cdbceb320da9b678f07c83ca95dbecf448e`.
Actual conflicts were only `PLAN.md` and `.remember/now.md`. The board now
records implemented retention separately from pending runtime acceptance; both
historical handoffs remain. Agent TEST ONLY, automation disabled, and complete
non-UI migration priority take precedence. The incoming Linear inventory had
one trailing blank line; it was removed for the whitespace check.

All 84 byte comparisons match their intended parent. Incoming canonical
criterion, fixed execution contract, complete original probe spec, immutable
completed provenance, and V1/absent compatibility equal fetched main. Retention,
operation-kind provider fence, response-body deadline/abort, and unknown-outcome
protection equal the supplied lane HEAD. Streaming/listener, finalization,
package/lock, and the unchanged schema-audit script equal fetched main. No
chat-review gate was restored and no product source repair was authored here.

Node 24.19.0 and pnpm 11.13.1 passed 592 scoped unit tests in 25 files and 538
DB tests in 17 files. Fresh Testcontainers migrated and cloned disposable fork
databases; existing DB/provider environment was excluded. Installed Pi-loop
and provider transports remain scripted/mocked. Typecheck, lint, build, ten
audits, regenerated Postman equality and whitespace checks passed. Lint retains
297 existing warnings. Counts overlap the earlier runs and must not be added.

Initial Postman/audit commands failed before execution because the chosen
temporary Unix-socket path exceeded macOS's length limit. All failure logs are
retained. The affected commands passed with a shorter cache path inside this
worktree. YUK-1375 remains an inherited audit limitation for absolute paths
containing test/spec tokens; this worktree's real schema audit reports 885
fields and zero unallowed stubs. No allowlist or audit script was changed, and
this result does not repair or relabel the earlier test-storage failure.

[Exact source and command evidence](evidence/2026-10-08-yuk1346-main1364-integration.json)
records both merge parents, every comparison hash, the 3147-file source-manifest
digest, actual commands, all log hashes, and the inspected runner provenance.
Logs and source manifests are under this worktree's
`.cache/yuk1346-main1364-20261008/`; no old runner logs were overwritten. No
full local `pnpm test`, delegation, review, push, PR/watch, Linear, private env
read, provider call, existing runtime/container/DB/queue operation, deployment
lock, or unknown replay was performed. Capture remains with the parent because
this lane is prohibited from Linear and found no new actionable product issue.

New exact-head CI, real provider/browser behavior, host-restart durability, live
revision and old unknown request outcomes/cost remain unverified. Parent owns
those actions. After the normal local commit this lane releases sole-writer
authority; later notifications do not reopen it.


## Integration of YUK-1375 audit repair

Normal merge of main `36f719675` into `39bb243c9`; conflicts only in PLAN and handoff. Application source remains unchanged from the previous accepted integration. The incoming audit implementation/tests equal main; allowlists are unchanged. Node24 scoped audit tests: 54 passed. Actual CLI: 885 fields, 0 unallowed, 41 existing allowed. Typecheck, lint and build passed. This verifies the repaired path filtering on the current branch; it does not retroactively validate prior affected runs. Earlier 592 unit/538 DB results remain attached to their original revision and were not rerun. No runtime/provider/replay operation.

- unit: exit 0; `.cache/yuk1346-main1375/unit.log`; SHA256 `a2b08f05bef55927a83284336851b341ba492714677a6bfd242ddf3b98277852`.
- audit: exit 0; `.cache/yuk1346-main1375/audit.log`; SHA256 `dcf9b31b80baa2ab85ecd72aad12df032efae015514bac30c02c5379f5a8a230`.
- typecheck: exit 0; `.cache/yuk1346-main1375/typecheck.log`; SHA256 `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`.
- lint: exit 0; `.cache/yuk1346-main1375/lint.log`; SHA256 `5673a4ef4d26f23561f6fba815d7a6c385816b69568e209d7989e1f957456e78`.
- build: exit 0; `.cache/yuk1346-main1375/build.log`; SHA256 `4a59cc8385237c6bd263d004db395042d756b39aa9533dc6c034388f81c7a120`.


## Integration of YUK-1376 typed mistake reads

Normal merge of main `c7c2482ca` into `07eb76cad`; conflicts only PLAN/handoff. All ingestion and records mistake code, public interface and SPA consumers equal main. Generated API/Postman files merged automatically and regeneration produces no diff. Scoped 13 unit and 59 disposable DB tests, typecheck, lint and build passed under Node24. No native frozen-evidence implementation is added here; that remains the other owner's separate lane. No runtime/provider/replay operation. Prior retention acceptance limitations remain.

- unit: exit 0; `.cache/yuk1346-main1376/unit.log`; SHA256 `c83cedd90766a355c99009a05f04eb5431d33e833774bec5ed1d3cabd8b2923a`.
- db: exit 0; `.cache/yuk1346-main1376/db.log`; SHA256 `d2ab61fd6110aaaca240539d8449375ea611c859782deb810413b9cc592611b4`.
- typecheck: exit 0; `.cache/yuk1346-main1376/typecheck.log`; SHA256 `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`.
- lint: exit 0; `.cache/yuk1346-main1376/lint.log`; SHA256 `8d35c2a5e46848ca4cfd43f5df44fb6c112927c1cae421dc604d1745a2517026`.
- build: exit 0; `.cache/yuk1346-main1376/build.log`; SHA256 `9362066e9490a35f54de610bd881ba7cfece988ac816bb1570c3696b7ba6df9b`.
- api-client: exit 0; `.cache/yuk1346-main1376/api-client.log`; SHA256 `f26bc904f865f0cc5a1a1613ea5d4017d46fdab55aceaf8eb0a831aedd0cea7c`.
- postman: exit 0; `.cache/yuk1346-main1376/postman.log`; SHA256 `3aaa19807ed6f0270b0c336b21a857618af66e696d351ca7ae870f0bd2f66a25`.


## Integration of PR1599 native frozen mistake reads

Normal merge of main `7bc216509` into `532f818a0`. Conflicts only PLAN/handoff. All four incoming source/test files equal main; Copilot and memory source is unchanged against the first parent. Typecheck, lint and build passed. No DB suite or container was launched while YUK1376 held the runtime window. Upstream DB/runtime evidence remains upstream evidence, not a new integrated-head run; exact-head CI is required. Native reference/reveal, complete media, Start/browser and old-entry exit limitations remain open. No provider, replay, deployment or shared runtime operation occurred.

- `src/server/records/mistakes.ts`: SHA256 `8970982e9a5e62b0d98f73e88d1362adb13799406648d808eb68ff39591db79f`.
- `src/server/records/native-mistake-evidence.ts`: SHA256 `094f2d773bee0d8ee3b99dd12b17fff7fe62abe8f8facdcf5eff2c44bb570161`.
- `src/server/records/native-mistake-evidence.db.test.ts`: SHA256 `b47711667765afd265be15ca6eaffbeae8befce7c55a398a86d986ce4f2c8fec`.
- `src/capabilities/ingestion/api/mistakes.db.test.ts`: SHA256 `157bb46c23be1cbd3a51d1c2da66d0f06c33b9ec7298ccd0a080574970347020`.
- typecheck: exit 0; `.cache/yuk1346-main1599/typecheck.log`; SHA256 `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`.
- lint: exit 0; `.cache/yuk1346-main1599/lint.log`; SHA256 `e71926fed8b65405ddc8521683e9c66391999206908f30a55d04a2b5d3f811f8`.
- build: exit 0; `.cache/yuk1346-main1599/build.log`; SHA256 `258ca803b8f965b97bf4cb5e0ccd253d6f4b50caae6c8ab5a1c92f74760f810e`.
