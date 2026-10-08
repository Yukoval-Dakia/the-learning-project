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
| Independent review | 823d5e09 | R1 found two cron fixture P1s; final R2 at64d9 resolves both, with NONE remaining P0/P1 | `/tmp/yuk1394-r1-review.md` |
| Repaired helper and build | 1ff5ef70 | Parent19 unit, full build and partition/provider/schema audits passed | `/tmp/yuk1394-parent-fixture-recheck/` |
| Retained prune/review regression | 1ff5ef70 | Four files,16 passed | `retained-families.log` and per-family evidence |
| Repaired full session cron | 1ff5ef70 | Both real family scenarios passed; timezone assertion failed | `session-cron.log` and `session-cron-evidence.json` |
| Timezone-only rechecks | 64d9f2eb | One case passed under Tokyo and UTC separately; two long scenarios unselected | `/tmp/yuk1394-parent-timezone-recheck/` |
| PR exact-head CI | Final source64d9 plus evidence commit | Pending final push and exact-head gate; historical cb984 is not evidence for this revision | Parent-owned delivery gate |

The initial immutable-evidence assertions matched the outer Drizzle error instead of its PostgreSQL cause. The repair checks exact P0001/message and unchanged receipts/ticks. The first backend case also inherited two real created queue jobs from the preceding family fixture. The repair validates the disposable fork and clears the selected test queues/schedules before and after each case. Product drain rules were not loosened. The parent reran both files together: 34/34 passed. With the initial nine unaffected files, all 167 distinct scoped cases now have passing evidence; repeated cases are not added to that count.

The migration checks apply 0117 to empty and populated post-1393 databases. They preserve eight selected domain/prune/review table snapshots, verify the two default family rows, cross-family constraints and immutable evidence. They are not a complete backup/restore drill.

The process run uses Node 24.19.0. Its actual bundled worker SHA-256 is `18a626201a36e2f4aa9cf31feb742e5051442ec2f434065c3abc49abfd15918a`; the evidence SHA-256 is `da910244ee7a9b23d34517991296c1b436157069dda2c0a5891c47a5687dd3b5`. It records 75 processes: 57 exit 0, 16 deliberate SIGKILLs, and two expected error exits for unknown outcomes. Both families exercise crash boundaries, lost COMMIT acknowledgments, actual pre-COMMIT rollback, unavailable-primary refusal, archived old handlers, and genuine predecessor prune/review recovery. This does not establish main-environment consumer exit.

## Runtime ownership

Every DB/process run uses a newly checked atomic deployment mutex and disposable Testcontainers databases. Before release, the helper checks its exact owner/token, original four container IDs/images/StartedAt/health, full running set and current-release digest. Release is refused while a temporary container remains; the assertions are not bypassed.

Completed releases: initial scoped DB at 20:05:26.378627Z, migration at 20:09:42.653272Z, process recovery at 20:13:30.293916Z on 2026-10-08 UTC. Corresponding `lock-release.json` files record unchanged main containers/release. Cron acquired token `ae66c067-dc6d-4498-b206-1b063c495346` at 20:14:18.338262Z; it was released at 20:26:41.040753Z after the cron run and the serial two-file DB recheck, with the original four containers/release/running set unchanged.

## Cron failure retained

The first real cron run passed the conversation scenario and failed the placement scenario. Worker47443 returned an explicit `Drain blocked` rejection because the other conversation family still had an accepted task in `created` state, ID `5fbf047e-d779-4e49-87e2-b25eff6b8400`. The fixture waited for forwarding to finish but did not wait for the forwarded task to settle. It then waited only for `ack`, hiding the already-received rejection until a 90-second timeout at line255. Product refusal is retained; no queue task was deleted or retried to force a green result. The full IPC log is in `cron-evidence.json`. The third declaration/timezone case was not executed after bail. The subsequent correction and actual rerun are recorded below; this original failure remains preserved.

## Existing review-orphan CI failure

Start PR1623 CI37836413386 DB3 failed in the existing review-orphan process suite. Its first reported query is producer-fence trigger installation; later cases fail or time out. The Start owner retained `/tmp/yuk1358-event-ci-db3-failed.log`. The completed read-only investigation found that failed cases could leave worker processes alive across resets; the nested PostgreSQL cause of the first concurrent-startup failure remains unknown. No flaky classification or production repair is claimed from the outer query message alone.

## Remaining delivery and migration obligations

R2 is complete with both findings resolved. Finalize the evidence commit and obtain exact-head CI for that final source before merge. The two-file DB recheck is already34/34 passed; retained-family16 and repaired cron evidence are recorded below. No third review is planned. Record source and runtime revisions separately.

The whole migration also requires the remaining task families, Start consumers, canonical startup and old SPA/pg-boss exit. Full stopped-writer restore verification must include DBOS execution state under the existing YUK-1359/YUK-1329 obligation. No whole-migration issue is closed by this slice.

## Fixture repair acceptance in progress

The sole author released clean HEAD `1ff5ef70bf85c5091bd7035a81f8f3529f8506a2`. Commit `3cec03813a41abbf0397d97e4e711736d3ad58f2` adds bounded nested PostgreSQL diagnostics and per-case captured process cleanup. Commit `6d5d782c318eb9b0ea2125063815051312f75f70` waits accepted legacy tasks and retains native workflow/admission/receipt history across cron scenarios. Product code did not change. The final commit only checkpoints the prior parent documentation unchanged.

Parent verified five source and three document hashes plus the delivered log manifest, then independently ran the diagnostic helper's 19 tests successfully. Its official CI placement is the existing DB partition through `tests/**/*.test.ts`; the isolated offline config was used only for no-DB local verification. Author final typecheck/lint exited zero; lint reported 290 warnings. Earlier failed author typecheck logs remain in the capture directory.

At 20:48:30.277989Z parent atomically acquired token `d6bc5144-e93c-466c-ad77-da14e947822c`, after the Start owner had explicitly released its event window. The first repaired selection-committed case passed in fresh disposable PG, with one SIGKILL and two concurrent recovery workers; all four children exited and no unresolved durable work was reported. It selected one case, leaving nine unselected. This does not identify the old CI's first SQL cause or establish full-suite success. Full retained-family verification then passed all four files and16 cases in577.02s. The review suite recorded35 exited children and no unresolved suite state. Parent checked the complete running set back to the original four and unchanged IDs/images/StartedAt/health/release before starting complete session cron verification in a new PG. That run subsequently finished as recorded below. New-build partition/provider/schema audits also exited zero. Evidence directory: `/tmp/yuk1394-parent-fixture-recheck/`.


### Complete cron result and timezone-only repair

The complete repaired cron run finished in720.36s with both real family scenarios passing and only the third UTC-mapping assertion failing. The first scenario retained6 SUCCESS workflows,12 ticks,4 receipts and3 dispositions. The second started with those exact rows and ended with12 SUCCESS workflows,22 ticks,8 receipts and6 dispositions; both had zero candidate/receipt gaps. The failed declaration case preserved that history too. This is direct evidence for both original R1 repairs, subject to the independent R2 conclusion.

The last case dynamically bound an unzoned wall clock as PostgreSQL timestamp. Installed postgres-js serializes inferred timestamp parameters with `new Date(value).toISOString()`. On the host's Asia/Tokyo timezone this moved04:25 to the previous19:25 before PostgreSQL applied Asia/Shanghai. Parent reproduced the exact nine-hour difference with the installed serializer. Commit `64d9f2eb62cec3cdb9ffbb7e3c189796e3b5cd30` only binds the parameter as text before casting to timestamp and asserts its roundtrip; expected20:25/20:35 UTC stayed unchanged. The one declaration case then passed separately under Asia/Tokyo and UTC processes, each with its own PG and the two long scenarios unselected. This is combined revision-specific evidence, not a claim that the entire three-case file was rerun on64d9. Final typecheck and scoped Biome passed.

Mutex d6bc was released at21:11:26.434834Z after the full run. The focused timezone window66cfd30d was separately acquired and released at21:13:51.836181Z. Both cleanup checks proved original four container IDs/images/StartedAt/health, complete running set and release unchanged. The [versioned evidence index](evidence/2026-10-09-yuk1394-parent-fixture-verification.json) seals logs, runtime data and cleanup receipts. No own service or lock remains.

The sole R2 task `yuk1394-session-orphans-verification-r2-20261009` completed with both original P1 findings RESOLVED and NONE remaining P0/P1. Parent recomputed and matched the full patch SHA256 `b30800065725c50df59740e4a1a7ba510920dfaca52125fa668760ed7312d25a`. The [final review](2026-10-09-yuk1394-review-r2.md) explicitly accepts the unchanged long-scenario evidence plus the narrow timezone rechecks, while preserving the unknown old SQL cause and production limits. Final source64d9 and these evidence documents will be pushed together; exact-head CI remains the outstanding PR gate. Review budget is exhausted; no third review is planned.

Final sealing lint first rejected array formatting in two task-owned evidence JSON files. Biome formatted those files without changing data; the complete lint recheck exited0 with290 existing warnings. Logs: `/tmp/yuk1394-parent-timezone-recheck/final-lint.log` and `final-lint-recheck.log`. No product or reviewed test changed during evidence sealing.

## Later CI startup failure

After sealing the original R2, parent fetched every failed job from CI37843803109 atcb984. DB1 session process fixture had13/21 passing cases and eight failures, beginning at placement row-uncommitted duplicate-worker startup. DB3 review fixture's new nested-error diagnostic supplies stronger evidence: PostgreSQL40P01 deadlock at `installSessionOrphanProducerFence`, while dropping the trigger onpgboss.job. Process1677 waited for AccessExclusiveLock on relation348366, held by1678;1678 waited for the same mode on348339, held by1677. These OIDs are not yet mapped to relation names. Exact parsed evidence is indexed separately. This establishes a real concurrent-startup deadlock for this run, but cannot retroactively establish the cause of the older1623 failure.

Source still gives each of the three fence installers a different advisory key while all touchpgboss.job andschedule. This is a diagnosis lead, not proof of the complete lock cycle or a validated fix. The sole implementation child owns session fixture diagnostics/cleanup; product changes require the parent's evidence-based decision. The prior R2's two cron findings remain resolved; it is not evidence that this newly retrieved failure is harmless. PR1624 will not merge on an incidental later green run without adjudicating this failure. No third review is started.

### Diagnostic fixture and bounded parent reproduction

The diagnostic writer completed and released1c99901bb. Parent inspected the two-file diff and matched13 source/log/patch hashes. Existing shared helper stayed unchanged. Nested errors now retain SQLSTATE and a bounded read-only catalog/lock snapshot on startup failure; per-case cleanup refuses subsequent reset after failed or unsettled work. Author19 offline helper tests, typecheck/lint/build passed. These are not DB acceptance.

Parent acquired mutex c9e0fd7a at21:40:37.297844Z and ran only the previously failing placement row-uncommitted case against a new disposable PG. Result1pass/20unselected, four exited children including one intended SIGKILL, no failed or unsettled case. This run did not reproduce the CI deadlock and supplied no new OID mapping. Parent did not repeat it to obtain green evidence. Initial release correctly refused a still-changing temporary container set; release succeeded at21:41:15.308100Z after the original four IDs/images/StartedAt/health, complete running set and release digest matched. See [evidence index](evidence/2026-10-09-yuk1394-startup-diagnostic-recheck.json).

PR1624 has been returned to Draft.5796 confirmed exclusive ownership of the three installers, a minimal common short-lock helper and scoped DB tests; Start/boot/shutdown/schema stay excluded and old binary quiescence remains mandatory. The sole product writer yuk1394-shared-producer-fence-lock-repair-20261009-v1 is implementing this repair and deterministic concurrent installer tests without runtime access. Parent will run DB and process regressions after writer release. No third review or production deployment is implied.

### Shared installer lock repair and parent acceptance

The product writer released clean1aeec5e366af2624c31ffe759780b63f24b92144. Parent matched25 source/evidence/log hashes and inspected the actual five-file patch. All three installers now take the same transaction advisory lock before their original family lock and any target DDL. The only existing product-file changes are this import/call and one corrected comment; queue creation, host lifecycle, schema and business operations remain byte-identical. The common lock serializes participating installers and releases at transaction end. It does not establish mixed-version safety or remove the old-binary quiescence obligation. This is parent review of the new product diff, not a third independent review or a claim that the earlier R2 reviewed it.

Parent ran the new nine-case regression and the existing review/session producer suites on a fresh PG: three files29/29 passed. Six ordered cross-family pairs showed the second transaction waiting on the shared advisory key, blocked by the first PID, before taking target relation locks. Three actual schedule CREATE failures returned PostgreSQL42883; the first family's original trigger OIDs/definitions were restored by rollback, the second installer completed, and both advisory/relation locks disappeared. Actual pg_locks and activity snapshots are versioned separately.

An isolated git archive of1aeec removed only the session installer's common-lock call. The selected prune/session case failed exactly because the second installer reached DROP with its legacy lock granted rather than waiting on the common lock. This is deterministic RED against the same test. Two earlier driver attempts remain recorded: pnpm refused automatic module-directory purge before tests ran, then an unquoted display-name filter selected zero cases. Parent used the existing dependencies with pnpm's invocation-scoped warn setting, confirmed the exact collected quoted test name, and reran only the corrected command. No install or dependency mutation was accepted. The bound candidate source remained unchanged.

Full session, review and prune process recovery then passed three files34/34 on1aeec. Session's21 cases recorded75 exited children:57 normal exits,16 deliberate SIGKILLs and2 expected error exits. Review recorded35 exited children and prune8, with no remaining suiteBlocked state. This covers concurrent host starts, original crash/unknown-outcome boundaries and genuine predecessor recovery on the repaired product. The earlier real cron evidence keeps its original revision; it is not relabeled as a new cron run.

Token833eaa33 was acquired21:53:12.320144Z and released21:57:31.631242Z after all test resources exited. Original four container IDs/images/StartedAt/health, full running set and release digest were unchanged. No provider calls, main queue replay or deployment occurred. [Verification index](evidence/2026-10-09-yuk1394-shared-fence-verification.json), [GREEN snapshots](evidence/2026-10-09-yuk1394-fence-green-evidence.json), [RED snapshots](evidence/2026-10-09-yuk1394-fence-red-evidence.json). Final parent typecheck/lint/build and six post-build audits (schema, capability boundaries, architecture deepening, provider lanes, provider attempt truth and test partition) all exited0. A fresh fetch found origin/main still6212a4560 with zero incoming commits. Exact-head CI after the final evidence push remains the delivery gate.
# CI integration repair: profile audit schedule

Exact `b9b019a3a` CI37850732224 unit shard2 failed only the existing cross-capability cron collision test;2409 tests passed in that shard. Raw job log is `/tmp/yuk1394-ci-b9b-unit2.log`. The parent reproduced the same failure locally:1 failed and10 passed. Main6212 already scheduled infra conversation cleanup and manifest profile audit at04:25 Asia/Shanghai; moving cleanup into the manifest exposed this existing collision.

The parent preserved conversation04:25 and placement04:35, moved only the read-only `subject_profile_audit_nightly` declaration to04:26 and corrected its comment.5796 confirmed no conflicting writer or timing dependency. The collision assertion is unchanged; no exception was added. A manifest regression now checks both cleanup times, audit04:26, timezone and fast queue.

The [declaration catalog](evidence/2026-10-09-yuk1394-cron-collision-catalog.json) records27 schedules and current hashes of all9 declaration sources. Seven match main6212 exactly; the other two diffs contain the orphan relocation and audit timing change. No other fixed daily declaration uses04:26. Frequent jobs still run that minute; no claim of exclusive runtime occupancy is made. Historical schedule receipts remain unchanged.

Parent final3-file scoped unit run passed32 tests; typecheck, lint and build exited0. Logs are `/tmp/yuk1394-cron-collision-{green-final,typecheck,lint,build}.log`. This was a source-only repair with no DB/container/provider/runtime operation. Prior recovery evidence remains tied to its original revisions; this does not claim an actual04:26 audit firing or another independent review round. A new exact-head CI is required before merge.
