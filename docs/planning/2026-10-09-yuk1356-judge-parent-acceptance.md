# YUK-1356 judge parent acceptance

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
