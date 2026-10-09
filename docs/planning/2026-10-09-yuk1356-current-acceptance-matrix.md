# Judge migration acceptance matrix

This is the current parent acceptance index after product `2dbb9eb3e` and parent process/cutover evidence `306fee061`. Latest update: twelve process and eight cutover cases now pass; see [process/cutover evidence](evidence/2026-10-09-yuk1356-parent-process-cutover.json). Earlier failures below are historical, not unresolved after this verified fixture repair.

It updates the execution status of the 27 scenarios enumerated in [R1](2026-10-09-yuk1356-review-r1.md). The historical R1 report remains unchanged. A passing DB test supports only its stated boundary; it does not establish the whole scenario or migration complete.

Evidence keys:

- **DB:** [128 distinct passing cases across eight scoped suites](evidence/2026-10-09-yuk1356-parent-dispatch-ack-db.json). This includes real transactions with controlled model boundaries, not paid provider output.
- **Process failure:** [first actual SIGKILL/reopen result](evidence/2026-10-09-yuk1356-parent-process-first.json). The workflow recovered, but zero wire requests and domain `infra_failure` contradict successful completion. The repaired fixture subsequently passed all12 process cases; the original failure is retained.
- **Prepared:** source exists, but no parent runtime pass is recorded.

| # | Required scenario | Actual evidence and remaining obligation |
| --- | --- | --- |
| 1 | Duplicate submit, same key, lost HTTP response | DB validates immutable dispatch identity and concurrent replay. Real Start/Pi request and response-loss behavior remain open. |
| 2 | Rate limit and pending transaction abort | DB covers refused admission, absent pending receipt, no send and refunds. |
| 3 | Crash after pending or reservation | DB covers lost commit acknowledgement. Actual pre-enqueue process death and reopen remain open. |
| 4 | Enqueue committed, acknowledgement lost | DB covers authoritative lookup and same-identity resend. The fixed old producer was exercised and fenced in the passing cutover suite. |
| 5 | Accepted send before notification; late markers | DB covers permanent truth and notification precedence. Live SSE delivery remains open. |
| 6 | Concurrent ticks, workers, submits and more than 200 candidates | DB covers keyset advancement, competing reservations, installer locks and duplicate effects. Real multi-process cases remain open. |
| 7 | Native load, stale head and admission | DB guards pass. The repaired fixture passed actual native-load crash/reopen with three real loopback wire calls. |
| 8 | Claim committed, process dies before wire | Actual claim-before-wire SIGKILL/reopen passes without repurchase. |
| 9 | Provider accepted, timeout, partial response and process death | Installed Pi transport reached the controlled endpoint; SIGKILL with the second response held recovered without a third claim or repeat wire request. External provider timeout and partial-response behavior remain unverified. |
| 10 | Global Pi retries preserved; judge retries disabled | Source/unit evidence and actual installed Pi transport counts pass for judge success and interrupted-response cases. This does not establish every external-provider retry branch. |
| 11 | First result saved, second unknown, third unclaimed | DB and actual process evidence pass: first saved result survives, second request remains unknown, and third unit is never claimed or sent after reopen. |
| 12 | Complete response but parse or result transaction incomplete | DB preserves unknown/held outcomes. Actual transport failure branch remains open. |
| 13 | Result commit acknowledged incorrectly | DB exact saved-outcome reread passes without repeating the executor. |
| 14 | Saved outcomes and an intervening candidate | Actual process case preserves the original binding against an intervening unactivated candidate without a wire call. Cutover import retains three claim-linked saved outcomes without another executor call. |
| 15 | Candidate seal, settlement and commit crashes | DB rollback/receipt failure and actual candidate-seal/pre-settlement-COMMIT SIGKILL/reopen pass. The pre-COMMIT crash leaves no activation; reopen reuses the candidate. |
| 16 | Activation committed before checkpoint or DONE | DB repairs missing completion notification without repeating effects. Actual domain-committed SIGKILL/reopen preserves one evaluation and makes no repeated wire calls. |
| 17 | Held or already effective before resolution | Native DB receipt identity and held-state cases pass. R2 must independently assess the final repair. |
| 18 | Manual disposition committed before FAILED | Operational DB tests invoke the sole reconciler and verify repair without direct projection or new execution. |
| 19 | Self-report, correction and withdrawal races | Native DB covers self-report and head conflicts; operational DB covers manual disposition. Complete correction/withdrawal consumer behavior remains open. |
| 20 | Two admissions, seven-day limit and live final delivery | Reconcile/operational DB cover bounds and a mid-sweep clock crossing. Both actual registered delayed-first-run and uncheckpointed SIGKILL/reopen cases reject authorization at or beyond seven days with no new send, reservation or model claim. |
| 21 | Failed, cancelled, DLQ and historical submit | Scoped DB supports retained historical submit handling. Complete old cohort and engine census remain open. |
| 22 | SSE reconnect, ordering, cursor and pruning | DB supports terminal projection and pruning recovery. Actual SSE reconnect/order/cursor acceptance is still missing. |
| 23 | Unavailable engine metadata and identity mismatch | Status/route DB cases pass. Real authenticated Start consumer acceptance remains separate. |
| 24 | Placement and intervention retention | All 13 placement and 49 intervention cases pass on isolated PostgreSQL after fixture-only repairs. They retain real mapped dispatch/reconciliation, completed-executor rejection, queue replay, corrupt/historical held evidence, notification-only compatibility, manual/resolved disposition and the complete intervention lifecycle. Original failures remain preserved. |
| 25 | Cutover against producer, cron, provider and restart | Shared fence DB tests pass. The fixed old producer cutover passes, including its late original blocking exit until disposition. Actual deployed cron/provider cohort quiescence remains open. |
| 26 | Old binary, compatible rollback and coherent restore | Fixed old producer and compatible rollback pass all eight cutover cases. Complete DBOS/domain/control restore is not proven by archive counts or health checks. |
| 27 | Bounded real provider output | Unrun. Requires fixed revision, input/output digest, task run, provider/model, cost and actual wire count. Controlled loopback transport cannot satisfy this row. |

Migration-entrypoint smoke now passes all 86 cases, including repeated emitted CJS startup and historical empty/populated 0117 migration boundaries. The full placement and intervention suites pass all 62 cases. [Parent evidence](evidence/2026-10-09-yuk1356-parent-consumer-repair.json) preserves both new failed runs, exact fixture patch and cleanup; the [original failures](evidence/2026-10-09-yuk1356-consumer-first-failures.json) are unchanged. Product source did not change.

The fixture child completed with no pending work. Parent verified the exact patch, 4 owned files, 27 references, 4907 tracked inputs, 884 artifacts and 7 logs. Last owner-checked lock release was 02:57:49.735956Z; original four services, running set and release were unchanged. Final configured static/build/ten audits and bounded emitted ESM/CJS logger proof pass, with [evidence](evidence/2026-10-09-yuk1356-final-gates.json). Real provider/Hono/SSE, native Start, the one remaining R2, exact-head CI and merge remain open. Default pg-boss compatibility is intermediate. Actual old consumer retirement, coherent restore and deployment remain explicit exit requirements.
