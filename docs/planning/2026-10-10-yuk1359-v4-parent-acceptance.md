# YUK-1359 v4 parent acceptance

The parent verified the repaired fault proxy offline and exercised it against a fresh real PostgreSQL source. The target COMMIT outage produced the required unknown outcome. Run09 still failed later, at the immediate database-client check after killing the pending worker. It did not reach capture, restore or same-target reopen.

## Offline evidence

Parent reruns passed all 558 inherited checks, 43 new protocol scenario groups, 299 single-split cases and two source checks. These sum to 902 at the reported granularity; they are not 902 database tests. The separate original-causality replay retained nine groups and 112 splits, including two product-flow cases with stubbed I/O. All offline runtime connection/listener/child counters were zero.

The parent inspected actual lifecycle and driver changes, reconstructed all 21 changed text paths from the patch, and verified 3,011 source bindings, 3,053 evidence bindings, 121,549 dependency files and 3,756 links. Source/evidence hashes matched again after the suite; fresh actual execution namespaces were empty before run09. Worker7472 and helperb52e stayed unchanged. V4 source seal is `a0fa9c5e3fd7089c1ce6450f190482534748f505f877fba70a2e0d4f7901dc60`, evidence seal `07f307942cf293b062654446006789535c13581c5f93885495519b8aa1f087f4`.

Reports are retained at `/tmp/yuk1359-dbos-restore-offline-prep-v4/static-tmp/parent-acceptance`; parent summary at `/tmp/yuk1359-restore-reopen-parent09/offline-acceptance.json`. The author's earlier packaging children are separate from these parent offline results. No product review round was added.

## Run09 observations

Mutex `e9d70004-7e57-4757-9c45-f1df2918d5b3` was acquired at 2026-10-09T17:56:12.651559Z after actual original-four health/release checks. Source `cfe49d747894ebc17474721f42678f5744f47b4b5db9903bb7046568b66fc35c`, port32789, database `test_fork_20261009175628`, completed 118 migrations and source setup.

- Complete worker70995 finished SUCCESS with three receipts and exited0.
- Unknown worker70997 committed its first receipt on pair2/backend136/transaction2. The proxy withheld completion, closed both existing application pairs, including pair1/backend129, and rejected six subsequent pairs. No protocol rejection occurred. Real failure IPC, ERROR, one receipt and two missing receipts passed before and after its owned SIGTERM settlement.
- Pending worker70999 reached the first-row boundary and acknowledged draining. The parent recorded the permanent source-restart prohibition and killed it with SIGKILL. OS process absence passed. The immediately following database check still saw one `postgres.js` client, backend139, idle. The strict check rejected continuation.

At 17:59:03Z a separate parent read-only query found zero other clients and the expected SUCCESS/ERROR/PENDING workflows with receipt counts3/1/1. This later observation does not retroactively pass run09, prove backend139's ownership, or establish its exact disappearance time. The failure and snapshots remain unchanged.

The source was stopped and retained. All three worker exits were recorded; the proxy had zero sockets and its port had no listener. At 17:59:06.566400Z the parent verified the lock owner/token, original four container IDs/images/start times/health, complete running set and release hash, then released the mutex. No provider, main worker, queue replay or deployment operation occurred.

[Versioned run09 evidence](evidence/2026-10-10-yuk1359-parent-restore-attempt09.json) includes the causal witness, failed gate, later read-only observation, worker exits, artifact hashes and cleanup receipt.

## Next bounded repair

The single task `yuk1359-postkill-db-settlement-prep-repair-20261010-v1`, Codex gpt-6.1-sol xhigh, owns only a fresh v5 revision of existing temporary PREP. It must verify ownership conditions before using bounded, read-only observation of known backend identities after an owned process exits. Unknown/new identities, database errors, missing exit evidence and deadlines must fail. Strict admission and final zero-client checks remain. No backend termination, status mutation, worker restart, arbitrary sleep, relaxed assertion or third review is authorized.

The v4 proxy, fixed worker, helper, dependencies and all run01–09 historical records remain read-only. The parent owns documents, tracker updates and later runtime. YUK-1359 remains In Progress; this fixture follow-up belongs to its existing restore acceptance scope and does not need a duplicate issue. Overall migration and judge/provider acceptance remain incomplete.
