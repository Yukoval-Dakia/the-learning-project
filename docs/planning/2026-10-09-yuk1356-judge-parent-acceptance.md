# YUK-1356 judge parent acceptance

Current execution status is maintained in the [27-scenario acceptance matrix](2026-10-09-yuk1356-current-acceptance-matrix.md). Sections below retain revision-specific history; earlier unrun statements are not the latest status.

Status: source candidate received; migration acceptance remains open.

## Fixed candidate and integration

Author commit `caa125504c04d6efcbd27e864a958bafeb303ddb` completed with no pending child runs and explicitly released the sole writer. Parent independently verified 63 changed source files against their git blobs and current bytes, 877 build/fixture artifacts, and 70 logs. All SHA-256 values matched. Root manifest digest: `43b8853b354d75c6f4e007a6d6d0701fdeb19b54943c682aecfd90ec471b4bfc`.

Parent fetched and normally merged main `7472f4395f4a12a5167e33034d5d8af8bf695049` as `e2fcaae9d`. Only PLAN and remember handoff conflicted; both histories were preserved. All 63 judge source blobs remained equal to the author candidate; all 20 incoming non-documentation files equal main. Raw manifests and parent verification JSON remain in `/tmp/yuk1356-implementation/`.

The author reports 363 scoped unit tests, root/Start typechecks, lint and full build passing. Parent inspected the sealed command records. Parent has not yet rerun those checks on the integrated candidate. The original failed build and audit logs remain preserved.

## Current source corrections

Only one repair writer is active: `yuk1356-judge-domain-and-init-audit-repair-20261009-v1`, Codex `gpt-6.1-sol`, xhigh. It owns the already authorized judge client/public dependency correction and the precise 0118 schema initialization audit with negative tests. Parent owns this report, PLAN/remember, acceptance and tracking.

- Capability audit reports practice→durable 4 against baseline 0; practice→events fell from 4 to 1, total 434 against 433. Each actual dependency category must satisfy its limit. No offsetting increases, allowlist additions or import hiding. Judge-specific engine operations belong with their domain and retain actual callers; shared host consumes the public seam.
- Schema audit classifies `judge_run_control.incarnation` as a stub. Its 0118 migration initialization needs a narrow contract bound to actual Drizzle schema, registered migration, exact singleton seed and immutability, with rejection tests. Existing 0117 evidence stays intact.

Ownership confirmation: `/tmp/yuk1358-judge-audit-ownership-20261009.json`. This is authorization, not verification of the repair.

## Logger evidence limit

Parent read `verify-built-logger.cjs`. It extracts the emitted DBOS logger factory from server/worker/migrate CJS products and evaluates it with controlled utility/serialization modules. It checks default/custom logger paths do not request optional packages, plus an expected failure when OTLP needs the optional transport. It does not load the Start ESM graph, and cannot establish absence of every surrounding dynamic-require failure.

Therefore the default emitted Start ESM and migrate CJS loading requirement remains open. Do not execute a production migrator or service entrypoint to fill this gap. Preserve the exact two-package optional external boundary and test the actual emitted loading path safely. OTLP-enabled behavior is outside the default-path claim.

## Runtime gates not run

No parent DB, migration, child process, provider, browser, runtime service or deployment ran in this turn. No lock or self-owned service exists from this work. Prepared commands are in `/tmp/yuk1356-implementation/parent-runtime-commands.sh`; they are not execution evidence.

After the source repair, acceptance still needs independent review, relevant DB and migration tests, real kill/reopen and cutover cases, existing-consumer behavior and the authorized provider output gate. Runtime work must acquire the existing atomic deployment lock and coordinate with thread 57961995. Full old cohort accounting, coherent restore, producer/cron quiescence and compatible rollback remain migration exit obligations.

## Offline loading follow-up and process preflight

Parent copied and independently rehashed 703 fixed Start-server/migrate files into `/tmp/yuk1356-parent-emitted-proof/snapshot`; snapshot.json binds each copy to the original source candidate. The separate T3 verification task `yuk1356-emitted-logger-offline-proof-20261009-v1` uses only that immutable copy and writes scratch evidence outside the repository. It cannot run DB, service, migration or worker entrypoints. This task is a loading-evidence investigation, not an independent product review or runtime gate.

Parent read the process and cutover launchers. The worker receives an explicit environment, requires a loopback `test_fork_*` database and loopback observer URL, and installs the actual Pi adapter with its model endpoint redirected to that observer. Its fetch guard rejects other origins. This is controlled transport evidence, not real provider quality evidence. The cutover suite builds the fixed old revision `96077db19` from a git archive. Both suites create resources and therefore still require the runtime lock.

Their child cleanup is in afterAll. Parent will run process and cutover files separately with Vitest `--bail 1`, preserve the failure/evidence before any rerun, and inspect remaining child processes as well as container cleanup before releasing the lock. Do not continue into a new fixture reset after the first failure or infer process exit from a test timeout. These are prepared execution precautions; no test was run here.

## Parent replay of bounded logger proof

The offline child completed and released its scratch output. Parent verified all 727 sealed proof files, read the extraction and probe code, and independently re-extracted the fixed snapshot. The ESM 50-declaration closure and CJS 20-declaration closure exactly matched the reviewed selected statements, dependencies, exclusions and byte hashes. Parent then ran both through native Node 24 loaders in an empty environment: both exited 0, used the actual emitted utility/serialization code, loaded no optional winston packages on the default path, and ended with no active resources. Native MODULE_NOT_FOUND on the optional OTLP branch served only as a negative control.

Evidence: [parent results](evidence/2026-10-09-yuk1356-parent-emitted-logger.json). This accepts the bounded logger-loading proof for original caa125504. It does not accept full Start/migrate startup, DB migration, OTLP, relocated package-version lookup, or the future repaired build. Repeat the bounded proof against the final immutable artifacts, then execute the separately authorized application/migration gates under the runtime lock.

## Audit repair received and first actual DB failure

Audit repair `5f09c7bdc9837988a67a5b37209835bf6e1fe50d` completed and released the writer. Parent independently verified 19 existing sources plus the deleted original, 884 artifacts and 30 logs. Parent's single scoped run passed all 337 tests across 12 files. Independent R1 `yuk1356-durable-judge-review-r1-20261009` is reviewing the full main7472→5f09 diff, SHA `c6513367117530ed040f61a9f7bd80f8dcd1880a1d14f0bdd7e42013a67bb869`.

The first actual DB gate failed. Under atomic lock token `0dba45a4-73b5-4dbb-af05-66a4f31b1b8f`, the parent ran eight scoped files with `--bail 1`. The first judge worker case returned done/correct and persisted one evaluation, but `judge_run.db.test.ts:62` found zero events with id=runId instead of one. Remaining tests were not established passing. The original failure is preserved in [the parent evidence](evidence/2026-10-09-yuk1356-parent-first-db.json).

Source tracing explains the skipped receipt: writeResolution calls readJudgeRunPermanent; after native activation/settlement, that reader reconstructs resolved even without a resolution event. The new writer guard treats this as an existing receipt and returns on the matching candidate. The later completion transaction repeats the same shortcut. Native truth recovery is valid for the read path, but it does not establish that the promised completion receipt was written.

A sole implementation task `yuk1356-native-resolution-receipt-repair-20261009-v1` now owns the narrow completion-receipt fix and scoped regressions. It must preserve the event=1 assertion, distinguish a concrete receipt from reconstructed native completion, retain conflict/fence/manual checks and never repeat learning/model effects. R1 was supplied the actual failure and source trace; no repair is accepted yet.

The test process exited1 and temporary PG exited. At `2026-10-09T00:22:54.189285Z`, owner/token verification plus exact original four-container/running-set/release comparison succeeded, and the lock was released. No provider, main worker, queue replay or deployment ran. Runtime acceptance remains open.

## R1 adjudication and receipt repair delivery

Independent R1 completed on the fixed 5f09 candidate. Parent reproduced its full diff SHA and accepted three P1 findings after reading the actual affected branches. See [R1 report](2026-10-09-yuk1356-review-r1.md). The first is reproduced by the parent's failed DB run. The other two are source-proven: the sweep excludes all disposed originals before its notification-repair branch, and each recovery authorization uses the historical tick timestamp rather than a current clock under the run lock. They remain runtime-unverified findings.

Receipt repair ff694bf18fbfe69bec96fa6b11a54a36e775aeaf is delivered and its writer has released ownership. Parent verified all three owned files,14 source inputs and884 copied/current artifacts with zero mismatch. The production diff distinguishes an actual immutable receipt from native completion under the run lock and verifies the stored receipt after first-write-wins insertion. Author41 unit tests, typecheck, lint and full build passed. Nineteen added DB scenarios are prepared but unrun; no P1 is marked resolved by this handoff alone.

The sole next implementation task is yuk1356-r1-notification-clock-evidence-repair-20261009-v1, Codex gpt-6.1-sol xhigh. It handles terminal notification selection and a fresh per-authorization clock, with prepared registered-workflow and boundary cases. It also corrects G3's concrete evidence omission: actual model results link through caused_by_event_id, not a submission_id payload field. This evidence correction is required before saved-outcome preservation can be claimed; no data loss or repurchase has been established for G3.

No runtime work occurred in this update. Parent will verify the repaired artifact, run coordinated DB/process gates, then use the single remaining R2. No third review is authorized. Linear1356 comment3ae6260e-c6e3-40e7-a6bc-ad73eeaf5d3d and the Start owner carry the same status; this is existing1356 work, not a duplicate issue.

## Acceptance command coverage follow-up

Parent read the prepared runtime commands against actual changed consumers. The list includes placement-native but omits the existing intervention consumer case in `src/capabilities/agency/server/intervention/intervention-preparation.db.test.ts`, named `consumes one real review per window, retires one-shot cards, and settles deterministically`. Add this case to the scoped DB run with `--bail 1` after the sole writer releases. Its current legacy fixture inserts a malformed pending payload, expects FAILED to reopen the card, then REQUEUED to fence it. The migrated consumer now uses permanent question activity. This is a potential compatibility/fixture-contract mismatch, not an observed failure; preserve the original test and adjudicate actual evidence before changing its expectations. Parent informed the sole writer for read-only assessment.

`tests/integration/migration-smoke.test.ts` builds migrate.cjs in beforeAll and executes the real emitted migrator twice against its disposable container. It therefore both requires the runtime mutex and mutates a build output. Seal final author products before this gate; record its generated migrate artifact and compare hashes afterwards. Repeat the bounded emitted proof on the final artifact actually accepted, rather than carrying the earlier caa proof forward.

The process suite covers SIGKILL/reopen at native-load, claim, candidate and domain-commit boundaries plus saved/unknown units and manual races. The cutover suite exercises a fixed old producer and compatible rollback. Neither establishes coherent whole-database DBOS restore or real provider output by itself. Those remain separately open acceptance requirements. All commands described in this follow-up are prepared, not executed.

## Repaired candidate actual DB gate

Writer71bd476225b0f4b704132bf74278c0de84be6d1b completed and released. Parent verified11 owned files,884 current/copied products,18 logs and4889 final inputs. The sole changed input was parent R1 JSON formatting, with semantic equality verified; parent full lint then passed. Author83 units/typecheck/build remain author evidence.

Parent acquired token61a3cbae at01:03:44.998Z. The unchanged original receipt case passed1/1 with24 unselected. The next three-file batch stopped at the first reconcile failure: writing judge_reconcile_observation failed the reserved event schema. Remaining cases are not accepted. The schema requires null for the family's caused_by_event_id, while the canonical writer normalizes null to undefined for parseEvent. The new sole writer owns only this family's schema boundary and focused regression tests; it must retain non-null run causality and immutable receipt comparison, leaving kernel/global writes unchanged.

At01:05:25.149Z temporary PG had exited and owner/token plus exact original four containers, running set and release matched; parent safely released the mutex. See [actual results and cleanup](evidence/2026-10-09-yuk1356-parent-repaired-db.json). No provider/main-worker/replay/deploy occurred. Linear1356 comment53d860bd-012a-4803-9414-c7e123d07284 captures the failure. RemainingR2 is still unused.

## Envelope repair verification and next actual defect

Parent verified the complete c9a0aab8a schema delivery:3 owned files,4892 final inputs,884 current/copied artifacts and14 logs matched. The original reconcile write case passed. Subsequent scoped runs exposed two test setup errors: raw SQL Date binding and a full-table job_events assertion despite resetDb retaining notifications. Parent changed only those fixtures in6981981b7, preserving product code and per-run assertions. The keyset case then passed; the next full three-file invocation reached43 passing cases before stopping on one native dispatch identity failure.

Changing userRating on an existing accepted original should reject coordinate_mismatch. The normal existing-row branch does reject, but its catch intended for lost COMMIT acknowledgment re-reads the pending row and checks only caller/submission ID before returning runId. Parent assigned a sole bounded writer to unify exact identity checks across both paths while retaining genuine COMMIT-loss recovery. Original assertion remains unchanged; noR2 has started.

Both test windows are cleaned. The final release first refused because the running container set had not finished settling; the lock stayed intact. Parent then observed only the original four healthy containers and verified complete snapshot/release equality before releasing at01:21:16.111Z. See [logs and cleanup receipts](evidence/2026-10-09-yuk1356-parent-envelope-db.json). No provider/main-worker/replay/deploy occurred. These partial results do not establish the three suites or entire migration passing.


## 2db dispatch identity and scoped DB acceptance

Parent verified five owned source files, 4895 build inputs, 884 current and fixed artifacts, and 13 logs against author hashes. The original changed-rating failure now passes on a real isolated PostgreSQL database. The whole native suite passes 53 cases after replacing a manually invented unauthorised recovery job with the actual coordinator output. The fixture still rejects absent authority, preserves the original pending row and reservation, applies the resend rate gate, and verifies one model execution after redelivery. No product change was made for this fixture.

Reconcile and operational suites pass all 21 cases, including the actual lost-COMMIT acknowledgement case. Five additional suites pass all 54 cases. Their migration negative now checks the exact nested PostgreSQL P0001/message and unchanged row, because Drizzle wraps that error. Across eight suites there are 128 distinct passing DB cases; earlier failures remain in the evidence logs. This does not establish process, old-consumer cutover, migration-entrypoint, real-provider, R2, CI or deployment acceptance.

Lock c761 was released at 01:40:06.385Z and lock 86d1 at 01:43:14.916Z after exact owner, original four containers, running set and release comparisons. The first 86d1 release refused while a temporary container was still exiting; the lock was retained until the equality check passed. No main service, provider or queue replay was touched. Evidence: `evidence/2026-10-09-yuk1356-parent-dispatch-ack-db.json`.


## First actual judge process acceptance failed

Candidate1535cf60c ran the production DBOS host and real installed Pi transport against disposable PostgreSQL and a guarded local HTTP endpoint. The first worker reached `native-load-committed`, received SIGKILL and exited. The second recovered the same workflow and returned engine SUCCESS, but the domain result was `review_required` with `infra_failure` and the local wire received zero requests instead of three. Therefore process recovery acceptance failed. The exact pre-wire error is not yet established; do not call this an external provider outage or a proven fixture defect. Other process/cutover/migration-smoke cases have not been run.

Full evidence remains in `/tmp/yuk1356-parent-process-db/process-evidence.json`, with hashes and cleanup in `evidence/2026-10-09-yuk1356-parent-process-first.json`. Both child workers exited and the disposable PG was removed. Lockf583 was released01:44:37.483Z after owner/token, original four containers, running set and release equality checks. No production runtime or paid provider call occurred. One source-only diagnostic writer now owns only the process test fixture and its diagnostics; product files remain read-only pending evidence. Earlier128scoped DB results stand, and R2 remains unspent.


## Actual process and old-producer cutover pass

All12 process cases and8 cutover cases now pass. They execute actual installed Pi transport against controlled loopback HTTP, real DBOS restart, SIGKILL/SIGSTOP boundaries, saved/unknown results, delayed authorization clocks and settlement rollback. Cutover builds actual old96077 source, using the matching installed pg-boss12.36, and proves pre-send death, fenced late producers, explicit historical disposition, compatible rollback and reuse of three claim-linked saved outcomes. They do not prove external provider quality, whole-runtime cutover or coherent backup/restore.

Each earlier fixture failure is preserved. Corrections register the proper installed transport, read original text blocks rather than their JSON encoding, inspect the actual JSON job parameter before SQL execution, initialize the official target DBOS schema before its inventory, and reject the real evaluation INSERT instead of overriding the wrong pooled transaction object. The latter checks the exact PostgreSQL cause and leaves three saved results but zero candidates. Product code and expected outcomes were retained.

The configured `pnpm typecheck` passes, including Start. The child had additionally run the JS TypeScript compiler and reported91 diagnostics; that result is retained separately from the configured native compiler gate, with no Start product change. Parent rechecked four source pairs,885 build pairs and916 artifacts.

Last lock release was02:09:13.043Z, after owner/token, original4 containers, running set and release all matched. Full failed and successful logs/snapshots are versioned in `evidence/2026-10-09-yuk1356-process-cutover.json.gz`; its index and limits are in `evidence/2026-10-09-yuk1356-parent-process-cutover.json`. Migration smoke, actual consumers, final emitted loading proof, real provider/SSE/Start, R2, CI and deployment remain open.

## Existing consumer and migration first run

At candidate `306fee061`, the actual built-migrator smoke passed 82 cases. Two historical 0117 suite setups rejected the appended 0118 migration because they asserted that 0117 remained the final entry; four cases were not executed. Placement passed five cases before its direct worker fixture was rejected for lacking permanent execution authority. The selected intervention lifecycle case failed when a malformed pending record remained held despite a FAILED notification. These are failed acceptance results, pending source-based fixture adjudication.

[Original logs, hashes and cleanup](evidence/2026-10-09-yuk1356-consumer-first-failures.json) preserve all three results. The parent released token `b6aee3b3-209b-4bc7-9e7b-946e66f18136` at `02:19:06.610008Z` after checking owner, original four containers, full running set and release equality. No provider, main worker, replay or deployment ran.

One Codex gpt-6.1-sol xhigh child owns only the three affected test files and its lane document. It must preserve real consumer behavior and report any product regression rather than weaken authorization or permanent-state rules. It cannot run DB/runtime work. Parent will rerun the relevant suites after the writer releases. R2 has not begun.

## Complete migration and existing consumer suites pass

Child fixture commit `90e87cfa9` is completed/noPending. Parent matched the exact four-file patch and all 4907 tracked input, 884 artifact, 27 reference and 7 log hashes. Migration smoke passed 86/86. The first complete consumer run uncovered another old placement fixture that stripped mapped authority and returned a fabricated delivery ID; the next run reached its direct replay of a completed internal executor. Parent repaired only that fixture, retained the executor's completed-state rejection, and exercised the real queue replay consumer instead. The full placement13 and intervention49 cases now pass. No product code changed and no assertion was relaxed to allow duplicate scoring or learner effects.

[Versioned evidence](evidence/2026-10-09-yuk1356-parent-consumer-repair.json) retains the 19pass/1fail/40unrun and 21pass/1fail/38unrun batches alongside the final 62pass result, exact parent patch and all three lock snapshots. Final release was02:57:49.735956Z; original four containers, running set and release were unchanged. Temporary container exit delayed two release attempts; the guard retained the mutex until exact equality passed. No provider, main worker, replay or deployment ran. Real provider/Hono/SSE/Start, final emitted proof, R2, CI and migration-wide cutover/restore remain unproven.

## Final local gates and emitted logger closure

On `fd5d79ee2`, configured typecheck, lint, full build and all ten documented local post-build audits passed. The first lint run found one parent evidence JSON formatting error; formatting preserved parsed JSON exactly and the failed log remains in the [final gates archive](evidence/2026-10-09-yuk1356-final-gates.json). No product source changed.

Parent copied and independently hashed710 final Start-server/migrate artifacts. The existing bounded extractor selected real emitted ESM/CJS logger, utility and serialization declarations. Both ran under native Node24 with empty environment and loaded the default DBOSConsoleLogger without optional winston packages or network/process resources. Serialization round-tripped the rich fixture. Enabling OTLP deliberately raised native MODULE_NOT_FOUND, so that branch remains unsupported by this proof. Full Start/worker entrypoint runtime acceptance is separate; emitted migrate startup was actually covered by the86 migration cases. This is final-artifact closure evidence, not whole-service acceptance.

A single test-role Codex gpt-6.1-sol high child is preparing a minimal offline recipe under ignored `.cache/yuk1356-live-acceptance/` and `/tmp/yuk1356-live-acceptance-prep/`. It cannot run DB/service/provider, read credentials, mutate tracked files or builds. Parent retains actual provider/Hono validation and R2. Task: `yuk1356-real-provider-hono-offline-prep-20261009-v1` in namespace e4c5132f. No runtime lock or self-owned service remains.
