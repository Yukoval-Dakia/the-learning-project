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
| Independent review | 823d5e09 | R1 running; no review conclusion yet | T3 task `yuk1394-session-orphans-review-r1-20261009` |
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

Start PR1623 CI37836413386 DB3 failed in the existing review-orphan process suite. Its first reported query is producer-fence trigger installation; later cases fail or time out. The Start owner retained `/tmp/yuk1358-event-ci-db3-failed.log`. Parent owns a separate read-only cause/isolation investigation. No flaky classification, blind rerun or product repair is claimed from that outer query message alone.

## Remaining delivery and migration obligations

Finish cron, recheck the two repaired DB files, validate retained prune/review process and cron behavior, complete integrated build/audits, adjudicate independent findings and obtain exact-head CI before merge. Record source and runtime revisions separately.

The whole migration also requires the remaining task families, Start consumers, canonical startup and old SPA/pg-boss exit. Full stopped-writer restore verification must include DBOS execution state under the existing YUK-1359/YUK-1329 obligation. No whole-migration issue is closed by this slice.
