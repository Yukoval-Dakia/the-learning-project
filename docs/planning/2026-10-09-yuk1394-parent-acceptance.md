# YUK-1394 parent acceptance

## Candidate and scope

Implementation `777bd38c58a68776a0e2d426764b6855d37a447d` was normally merged with main `6212a4560c68c294245dc3f3e10e4f774c6ff6f8` as `7e29a9ae457a9bc3676753bab5d30450785fa3f2`. Only planning handoffs conflicted. Parent verified all 33 author source files, 14 logs and 14 built artifacts against the delivery hashes.

`6c93431575fbe8bb8b36404df85a5d98bf30fcdf` adds a closed audit contract for the registered 0117 initialization. It does not add an allowlist exemption or claim runtime writes. `823d5e09edbfdf1886d04625c89763a1bfe67242` repairs two test fixtures. Parent verified 32 source/log hashes from that delivery, including the unchanged original failure logs. Schema, migration and journal remained byte-identical.

Only conversation and placement orphan housekeeping are in this delivery. Their default backend remains pg-boss. Source merge, independent disposable-process tests and a production cutover are separate milestones. No main service, private data, provider, worker queue or deployment was changed by this acceptance.

## Observed results

| Layer | Candidate | Result | Evidence |
| --- | --- | --- | --- |
| Initial scoped DB, 11 files | 7e29a9ae | 164 passed, 3 failed, 167 total | `/tmp/yuk1394-parent-db/tests.log` |
| Scoped 0117 migration | 7e29a9ae | 4 passed; 82 unrelated cases not selected | `/tmp/yuk1394-parent-migration/tests.log` |
| Actual process recovery | 823d5e09 | 21 passed | `/tmp/yuk1394-parent-process-r1/tests.log` and `process-evidence.json` |
| Actual cron and family rollback | 823d5e09 | Conversation passed; placement failed at other-family drain; declaration case unrun after bail | `/tmp/yuk1394-parent-cron-r1/` |
| Changed DB fixtures together | 823d5e09 | 2 files, 34 passed | `/tmp/yuk1394-parent-db-recheck/tests.log` |
| Parent scoped unit | 823d5e09 | 8 files, 245 passed | `/tmp/yuk1394-parent-static/unit.log` |
| Parent static/build | 823d5e09 | typecheck, lint, full build and eight post-build audits passed | `/tmp/yuk1394-parent-static/results.json` |
| Independent review | 823d5e09 | R1 found two cron fixture P1s; no production P0/P1 established. R2 pending repair runtime evidence | `/tmp/yuk1394-r1-review.md` |
| PR exact-head CI | None | Not run; PR not created | Parent-owned delivery gate |

The initial immutable-evidence assertions matched the outer Drizzle error instead of its PostgreSQL cause. The repair checks exact P0001/message and unchanged receipts/ticks. The first backend case also inherited two real created queue jobs from the preceding family fixture. The repair validates the disposable fork and clears the selected test queues/schedules before and after each case. Product drain rules were not loosened. The parent reran both files together: 34/34 passed. With the initial nine unaffected files, all 167 distinct scoped cases now have passing evidence; repeated cases are not added to that count.

The migration checks apply 0117 to empty and populated post-1393 databases. They preserve eight selected domain/prune/review table snapshots, verify the two default family rows, cross-family constraints and immutable evidence. They are not a complete backup/restore drill.

The process run uses Node 24.19.0. Its actual bundled worker SHA-256 is `18a626201a36e2f4aa9cf31feb742e5051442ec2f434065c3abc49abfd15918a`; the evidence SHA-256 is `da910244ee7a9b23d34517991296c1b436157069dda2c0a5891c47a5687dd3b5`. It records 75 processes: 57 exit 0, 16 deliberate SIGKILLs, and two expected error exits for unknown outcomes. Both families exercise crash boundaries, lost COMMIT acknowledgments, actual pre-COMMIT rollback, unavailable-primary refusal, archived old handlers, and genuine predecessor prune/review recovery. This does not establish main-environment consumer exit.

## Runtime ownership

Every DB/process run uses a newly checked atomic deployment mutex and disposable Testcontainers databases. Before release, the helper checks its exact owner/token, original four container IDs/images/StartedAt/health, full running set and current-release digest. Release is refused while a temporary container remains; the assertions are not bypassed.

Completed releases: initial scoped DB at 20:05:26.378627Z, migration at 20:09:42.653272Z, process recovery at 20:13:30.293916Z on 2026-10-08 UTC. Corresponding `lock-release.json` files record unchanged main containers/release. Cron acquired token `ae66c067-dc6d-4498-b206-1b063c495346` at 20:14:18.338262Z; it was released at 20:26:41.040753Z after the cron run and the serial two-file DB recheck, with the original four containers/release/running set unchanged.

## Cron failure retained

The first real cron run passed the conversation scenario and failed the placement scenario. Worker47443 returned an explicit `Drain blocked` rejection because the other conversation family still had an accepted task in `created` state, ID `5fbf047e-d779-4e49-87e2-b25eff6b8400`. The fixture waited for forwarding to finish but did not wait for the forwarded task to settle. It then waited only for `ack`, hiding the already-received rejection until a 90-second timeout at line255. Product refusal is retained; no queue task was deleted or retried to force a green result. The full IPC log is in `cron-evidence.json`. The third declaration/timezone case was not executed after bail. A bounded fixture correction and actual rerun remain required.

## Existing review-orphan CI failure

Start PR1623 CI37836413386 DB3 failed in the existing review-orphan process suite. Its first reported query is producer-fence trigger installation; later cases fail or time out. The Start owner retained `/tmp/yuk1358-event-ci-db3-failed.log`. The completed read-only investigation found that failed cases could leave worker processes alive across resets; the nested PostgreSQL cause of the first concurrent-startup failure remains unknown. No flaky classification or production repair is claimed from the outer query message alone.

## Remaining delivery and migration obligations

Finish repaired cron and retained prune/review process and cron behavior, complete integrated build/audits, perform the single R2 verification, adjudicate independent findings and obtain exact-head CI before merge. The earlier two-file DB recheck is already 34/34 passed. Record source and runtime revisions separately.

The whole migration also requires the remaining task families, Start consumers, canonical startup and old SPA/pg-boss exit. Full stopped-writer restore verification must include DBOS execution state under the existing YUK-1359/YUK-1329 obligation. No whole-migration issue is closed by this slice.

## Fixture repair acceptance in progress

The sole author released clean HEAD `1ff5ef70bf85c5091bd7035a81f8f3529f8506a2`. Commit `3cec03813a41abbf0397d97e4e711736d3ad58f2` adds bounded nested PostgreSQL diagnostics and per-case captured process cleanup. Commit `6d5d782c318eb9b0ea2125063815051312f75f70` waits accepted legacy tasks and retains native workflow/admission/receipt history across cron scenarios. Product code did not change. The final commit only checkpoints the prior parent documentation unchanged.

Parent verified five source and three document hashes plus the delivered log manifest, then independently ran the diagnostic helper's 19 tests successfully. Its official CI placement is the existing DB partition through `tests/**/*.test.ts`; the isolated offline config was used only for no-DB local verification. Author final typecheck/lint exited zero; lint reported 290 warnings. Earlier failed author typecheck logs remain in the capture directory.

At 20:48:30.277989Z parent atomically acquired token `d6bc5144-e93c-466c-ad77-da14e947822c`, after the Start owner had explicitly released its event window. The first repaired selection-committed case passed in fresh disposable PG, with one SIGKILL and two concurrent recovery workers; all four children exited and no unresolved durable work was reported. It selected one case, leaving nine unselected. This does not identify the old CI's first SQL cause or establish full-suite success. Full retained-family verification then passed all four files and16 cases in577.02s. The review suite recorded35 exited children and no unresolved suite state. Parent checked the complete running set back to the original four and unchanged IDs/images/StartedAt/health/release before starting complete session cron verification in a new PG. That three-case run is pending. New-build partition/provider/schema audits also exited zero. Evidence directory: `/tmp/yuk1394-parent-fixture-recheck/`.
