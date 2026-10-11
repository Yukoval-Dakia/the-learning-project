# YUK-1356 durable judge implementation candidate

This is a source candidate for the bounded `judge_run` + `judge_pending_reconcile` family. It is not runtime acceptance or final migration exit. Parent owns independent review, DB/process/migration execution, provider acceptance, Start consumer acceptance, PR/exact-head CI, cutover, rollback rehearsal and deployment.

The accepted direction is the implementation entry, operational contract/source seal, the entire `/tmp/yuk1355-judge-durable-design-20261009.md` acceptance matrix and ordered cutover, and `1712199f5:docs/planning/2026-10-09-judge-start-ownership.md`. Initial branch HEAD was `4ad4c58a5ee8a3396689681dca83b539d091924a` on main `96077db1905ebab6a522b0ae36f9f22e26be5895`. Parent documentation commits advanced this branch during implementation and were preserved. Fresh inventory fetch observed origin/main `7472f4395f4a12a5167e33034d5d8af8bf695049`; it has no 0118 collision. No merge, branch switch or worktree creation was performed. Migration 0118 remains this lane's allocation.

## Implemented production path

- Native dispatch retains original run/pending IDs and captures before enqueue. Family SHARE then run R protects admission, reservation and immutable send authorization. Drain is an explicit 503, including when the durable route is enabled; it does not invoke synchronous scoring. Unknown COMMIT/enqueue outcomes preserve the slot and token. Known pre-send rejection is recorded and may refund the current live token.
- Typed permanent events represent binding, reservation, send, acceptance, rejection, start, disposition, ownership, family transition and frozen sweep observation. The singleton control begins in pg-boss with a fresh incarnation. The receipt writer parses and compares stored envelope/payload identity instead of relying on `writeEvent`'s duplicate-ID behavior. Replay preserves recorded timestamps. SQL supplies partial unique indexes and immutable operational-row protection.
- Execution binds attempt/input/intent/policy before any model claim. Recovery reuses native unit result IDs and the bound attempt. An intervening candidate does not allocate max+1; an unknown/held unit blocks subsequent fresh claims. Claim/result remain the effect fence. Task success, workflow success and cost never become grades.
- Durable judge retry is a typed per-call `none` option through the runner, Pi model adapter, actual Options and installed Pi lower transport; Jev receives the same typed retry override. Global, direct and Copilot policies are preserved. The installed Pi transport unit test observes one controlled fetch for judge policy and three for the existing global retry setting, without opening a socket.
- Model I/O happens outside business transactions. Existing G/group locks precede R. R precedes fresh claim C, candidate sealing, capture A, activation's `recordOriginal`/native settlement callback and resolution. Manual takes R only and checks exact native completion. Late saved evidence is retained but cannot seal or activate after manual. Existing native scoring, candidate, activation, settlement and current effective verdict remain authoritative.
- A single practice selector/reducer supplies HTTP/public, placement and intervention reads with the injected Db/Tx. HTTP adds engine observation after its short read-only transaction and makes one bounded re-read. Unavailable/mismatched/pruned metadata is distinct from verified absence. The four-state DTO, original/effective IDs, 202 Location/backfill/SSE URLs and native dispatch port remain compatible.
- All judge notification projections now re-read permanent truth under R. Delayed send acknowledgments cannot reopen manual/completed truth, and the existing reconciler repairs missing DONE/FAILED projections without inference. Generic SSE is unchanged. Placement retains held/settled behavior; diagnostic reads retain the accepted-original guard after notification retention.
- Both family declarations register before the single existing DBOS launch. Workflow identity/input/name/queue/application/version are checked. Web uses DBOSClient; only the existing worker host executes. The paired reconcile workflow is the sole recovery owner. Keyset cursor plus retained tick selection advances past a 200-row prefix; no second timer or recovery subsystem was added. Existing housekeeping workflow names/version/schema and lifecycle are retained.
- Family transitions require ordered drain, exact epoch, fresh sealed complete source inventory and quiescence references. Inventory includes terminal jobs, retries, DLQ, ticks, malformed forwarders, schedules, pending originals and unresolved claims. Imports require native frozen input, source seal, matching incarnation/next epoch, known retained recovery history, available occupied slots, <7-day age and source engine evidence for accepted deliveries. Unknown claims/history and failed/DLQ work require disposition. Rollback transfers ownership on compatible code without deleting receipts or resetting budgets.

## Validation and limits

Logs, source/SDK seals, changed-file inventory and SHA-256 manifests are under `/tmp/yuk1356-implementation/`. The final commit and exact outcomes are recorded in its handoff. All commands used Node 24.19.0 and existing pnpm dependencies. No install, paid/model network call, service, port, DB test, migration execution, process fixture execution, container, push, PR or tracker action was performed.

| Layer | Evidence |
| --- | --- |
| Scoped unit | Final release checks passed 363 tests in 12 files; judge receipts, installed Pi retry transport, runner policy, Jev, native evaluator authority, manifest and shared-host lifecycle. Earlier 342-test scope logs are retained. |
| Typecheck | Root and Start typechecks passed. Final candidate log records the last source revision. |
| Lint | Owned files pass. Repository lint passes with existing warnings after parent's evidence JSON formatting repair; original failed log retained. |
| Full build | Original Start and migrate failures retained. Authorized optional logger external repair then completed the full web/Start/server/worker/migrate build. Final candidate build log is authoritative. Backend-only successes were never substituted for this gate. |
| Bundle probe | Isolated emitted SDK logger factories from server/worker/migrate load in a VM with controlled utility dependencies: default and custom logger paths require no optional package; enabling OTLP requires its optional transport. Entry points were not executed. CJS syntax checks pass. This is not service/runtime acceptance. |
| Source audits | API contracts, provider lanes, provider-attempt truth, structured judge and test partition pass. Partition has no P0; existing unmatched cache copies/warnings remain. |
| Blocked audit edits | Capability baseline and schema initialization contract require excluded audit ownership, described below. Neither is reported PASS. |
| DB/process/migration | Ten owned/integration test files collect without running global setup. New and retained suites are UNRUN. Process binaries compile only. |

Final own review preserved `evaluation_busy` as infrastructure contention under the existing pg-boss retry budget, while candidate-slot/input conflicts terminate without fresh model work. Its additional DB regression is authored and UNRUN. Final release logs are `unit-release.log`, `typecheck-release.log`, `lint-release-review.log` and `build-release.log`; source/product/log hashes in the handoff bind these checks to the committed candidate.

Two excluded audit edits remain for parent: `scripts/capability-boundary-baseline.json` reports practice→durable 4 versus baseline 0, practice→events reduced from 4 to 1, total 434 versus 433. This reflects the accepted judge client/observation seam and centralized notification writer. Parent should review/accept the seam and tighten the baseline, rather than hide the new dependencies. `scripts/audit-schema-writes.ts` currently marks `judge_run_control.incarnation` an unallowed stub because its immutable initializer exists only in registered migration 0118. It needs a narrow validated first-batch/journal initialization contract analogous to the existing 0117 family contract. There is no unused mutable incarnation API and no allowance added to bypass the audit.

The only ownership extension received was `server/start/vite.config.ts` SSR/Rolldown optional externals and `package.json`'s `build:migrate` optional externals. Receipt: `/tmp/yuk1358-judge-logger-build-ownership-20261009.json`, confirmed by parent at message position 9028. Only `winston`/`winston-transport` are externalized; SDK remains bundled. SDK `GlobalLogger` returns its console logger before requiring these packages when OTLP is disabled. No logging configuration, lockfile, dependency or boot behavior was changed.

## Acceptance matrix handoff

Every DB/process entry below is authored or retained, not executed. `operational` means `tests/dbos-judge/operational.db.test.ts`; `process` means `tests/dbos-judge/process.db.test.ts`; `cutover` means `tests/dbos-judge/cutover.db.test.ts`.

| Accepted scenario | Prepared evidence / remaining parent acceptance |
| --- | --- |
| Same idempotency key, duplicates, lost 202, changed coordinates | Native durable attempt suite; operational lost pending COMMIT acknowledgment fixture preserves same original/reservation. Start/Pi external entry acceptance remains parent-owned. |
| Admission 429 / pending Tx abort | Operational rate-limit/abort fixtures assert no executable pending, no send and only an acquired live token refund. |
| Pending/reservation crash before enqueue | Operational unknown COMMIT fixture; actual old producer SIGKILL before its real pg-boss INSERT in cutover. |
| Lost enqueue ack / delayed first send | Reconcile exact lookup and concurrent fixed-slot fixtures; permanent reducer distinguishes unknown from absence/reserved from accepted. |
| Accepted before notification / late markers | Operational manual projection-crash repair and late requeue; native terminal notification outage suite; status reducer unit cases. |
| Concurrent cron/workers/submit; >200 prefix | Reconcile concurrent ticks/slot identity and 205 malformed-prefix fixtures; native concurrent HTTP/worker suite. |
| Worker starts before native load; stale head/admission | Production worker entry/native-load boundaries; native self-report-before-pickup and frozen admission/head fences. |
| Claim committed before HTTP then SIGKILL | Process `claim-committed` kill/reopen with controlled wire count; unknown is held even without a task row. |
| Provider accepted/lost response/partial stream/process death | Process held second wire then kill/reopen; installed transport transient 503 unit proof. Additional live provider failure/stream probes require separate authorization. |
| Global Pi retries2 / task retries0 | Installed real lower transport unit proof plus runner transient retry override and ordinary policy regressions. |
| First saved / second unknown / third unclaimed | Operational and actual process multiunit fixtures, conserved claim/result IDs and no third wire. |
| Full response but invalid parse or uncommitted result | Recorded-executor failure/native held regressions; claim-kill process boundary. Parent may inject an additional result-persistence outage in the controlled run. |
| Result COMMIT ack lost | Operational transaction wrapper throws after real COMMIT; exact saved result read, no executor replay. |
| Binding crash plus alternate unactivated candidate | Process native-load kill then normal native alternate evaluation, zero new wire, no max+1. |
| Candidate seal / settlement crash or commit acknowledgment | Candidate-sealed process kill; real settlement-before-COMMIT SIGSTOP/SIGKILL/reopen; native resolution rollback fixture. |
| Activation/resolution before checkpoint/DONE | Process domain-committed before checkpoint kill, native terminal outage/recovery, permanent read beats unavailable/pruned engine. |
| Held/already-effective before resolution | Native held/self-report original/effective identity suite and process held-candidate boundary; permanent exact activation/settlement proof. |
| Failure disposition before FAILED / projection outage | Operational projection-crash repair and retained terminal notification failure/retry tests. |
| Manual/correction/withdrawal during inference | Operational manual during inference, process manual after final saved result, effective/held candidate seals; existing native self-report/head guards. Parent still owns full correction/withdrawal and Start flows. |
| Two recoveries / marker loss / 7-day edge / live final | Permanent reducer unit tests and reconcile DB fixtures. Engine restart count is separately bounded. |
| FAILED/cancelled/DLQ / legacy caller submit | Complete census and required task dispositions, historical submit reconcile fixture, old producer cohort/rollback test. |
| SSE reconnect/order/duplicates/Last-Event-ID/pruning | Status unit and retained generic replay/listen tests; permanent pruning and notification repair DB fixtures. Live reconnect/Start acceptance remains parent-owned. |
| Status metadata unavailable/mismatched | HTTP DB route distinguishes 503 from 404, known pending remains nonterminal, bounded observation race. |
| Placement/intervention after retention | Shared Tx reader/independent observer/rollback DB fixture; native placement and accepted diagnostic regressions retained. Parent executes those real consumer flows. |
| Cutover against producer/cron/provider/restart | Common installer-lock DB matrix, complete fresh census/epoch gates, shared-host unit proof and actual old producer cutover fixture. Live cron/provider quiescence remains operator evidence. |
| Actual old binary and compatible rollback | Sealed old source `96077...` compiled separately; actual old producer paused before send, later producer fenced by DB trigger, unmapped late original blocks transition; compatible return preserves occupied slots. Controlled fresh DBOS census and mapping required. |
| Bounded real provider actual-output case | UNRUN, separately authorized by parent. Freeze exact revision/input/output digests, task/provider/model/cost and wire evidence; never repay a killed paid unknown to obtain green. |

## Parent execution and operator sequence

Run under the parent's runtime lock and existing DB/container authorization; these commands are prepared and were not executed here:

```sh
export PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH
pnpm vitest run --config vitest.db.config.ts tests/dbos-judge/migration.db.test.ts tests/dbos-judge/operational.db.test.ts src/capabilities/practice/server/native-durable-attempt.db.test.ts src/capabilities/practice/jobs/judge_run.db.test.ts src/capabilities/practice/jobs/judge_run-terminal.db.test.ts src/capabilities/practice/jobs/judge_pending_reconcile.db.test.ts src/capabilities/practice/api/judge-run-status-route.db.test.ts src/server/durable/producer-fence-lock.db.test.ts
pnpm vitest run --config vitest.db.config.ts tests/dbos-judge/process.db.test.ts
pnpm vitest run --config vitest.db.config.ts tests/dbos-judge/cutover.db.test.ts
pnpm vitest run --config vitest.migration.config.ts tests/integration/migration-smoke.test.ts
pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/api/placement-native.db.test.ts
```

The process suite builds `.cache/yuk1356-judge-worker.cjs`, starts the existing production durable host and installed Pi transport against a loopback controlled observer, and kills/reopens real child processes. It rejects non-observer egress and non-fork/non-local DB URLs. It records wire digests, receipts, candidates/settlement snapshots, workflow steps, process exits and source/SDK/bundle hashes in `.cache/yuk1356-judge-process-evidence.json`. The cutover suite archives the entire sealed old source into a retained temporary directory and compiles the actual old producer, with evidence in `.cache/yuk1356-judge-cutover-evidence.json`. Installer evidence is `.cache/yuk1356-producer-fence-lock-evidence.json`. Keep failed evidence before any fixture reset/re-run.

Operator functions in `judge-family.ts` are bounded controls, not a second execution owner: install the common-lock producer fence, inspect the complete legacy inventory, seal source/full backup and old-process quiescence, enter draining-pg-boss, resolve/dispose every obligation, inspect each import's source digest and known budget, map only proved native gaps to the next epoch, then finish dbos with a fresh inventory. Reconcile sends mapped reservations. Failed/DLQ, unknown history/claims, malformed tasks and unfinished historical submissions are manual; accepted records with pruned engine evidence do not automatically transfer. Pause and prove source cron/dequeue/producer quiescence outside business transactions. For rollback, drain dbos, obtain the complete DBOSClient census outside Tx, settle/dispose/map every obligation and return to pg-boss only on compatible code. Preserve full DBOS/domain/control/queue backup and receipts.

Default pg-boss mode and retained compatibility handlers/read helpers are an implementation staging state. They do not establish final exit. Parent must prove zero executable legacy jobs/retries/DLQ/ticks/forwarders, all originals/claims accounted for, old binary/process quiescence, final live producer/liveness retirement, coherent backup/restore, scheduled DBOS recovery, compatible rollback and Start consumer acceptance before claiming the migration complete.
