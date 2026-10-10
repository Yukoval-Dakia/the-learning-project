# YUK-1359 v5 parent acceptance

Run10 passed all source scenarios and actual full database restore parity. It stopped before launching any restored worker because PREP compared physical column positions across the source and restored databases. Same-target DBOS reopen remains unrun; this is not a completed restore/reopen gate.

## Fixed artifacts and offline evidence

The parent inspected the v5 post-kill settlement code and reran 558 inherited checks, 43 protocol groups with 299 split cases, 29 settlement groups and two source checks. These total 931 at the stated granularity, not 931 DB tests. A separate original-causality replay retained nine groups and 112 splits. Connection/listener/child tripwire counts were zero. All 3,015 source bindings, 3,053 evidence bindings, 121,549 dependency files and 3,756 links matched; source/evidence were checked again after the suite. Fresh actual namespaces were empty before execution.

Worker source `7472f4395f4a12a5167e33034d5d8af8bf695049` and helper source `b52e255f746ebbf6a4f2f44ae06e7d1b672a4fff` remained fixed. The worker executable digest is `4e2ec8ace103cf535c3472f2f2c4611438d8cfe5a6f14a1c65abe272674824a9`. V5 source seal is `d139fb16c1bc958dc4da5d8b2b9f6057178fbf03818fe4f3c485c49be15b7e68`; evidence seal `ff574b3448857e5042b95045b863dd9aa4dd7a5246b6c244df89fced43c3c5f5`. [Parent offline report](evidence/2026-10-10-yuk1359-parent-v5-offline.json).

## Actual source and restore

The parent acquired token `d916ad37-f192-48f2-950f-a96474398874` at 2026-10-09T18:22:54.559936Z after checking the original four containers and Agent TEST release. Only fresh source `7361d71f3fc3422fda92b05702fbb248cd3c1cf23d629b5c0dc5d76027fb3b41`, loopback32790/database `test_fork_20261009182310`, was provisioned through 118 migrations.

- Complete worker547 exited0 with SUCCESS and three receipts.
- Unknown worker672 encountered the real identity-bound COMMIT outage, retained ERROR with one committed receipt and two missing receipts, and settled by owned SIGTERM.
- Pending worker884 committed its first row, acknowledged draining and was killed by SIGKILL. Before killing it, the observer captured eight exact backend identities under operational exclusion. OS exit/PID absence passed; the first post-exit database observation was empty. No backend termination or arbitrary grace period was used. Operational mutex/sole-disposable-worker ownership is distinct from OS socket-to-process attribution.

Capture exited0 against the writer-free source. The exact dump digest is `54cc18f6628162728c25a795018cb56424abba3fd3a8de3cdefeae921a1a6cf8`. Restore exited0 to retained container `0127ceec1507f5af8a6cc0e80752fe8e68a3d5d03f6973b4e9ee87290770f99a`, loopback49988/database `test_fork_20261009182841`. The receipt has `verified:true`, level `database-content-parity`, algorithm `pg16-column-text-sha256-multiset-v2`: four schemas, 123 tables, five sequences, no missing/extra/mismatched entries or environment mismatch. This includes non-system DBOS and pg-boss state. The capture helper records current checkout revision3a16662 in its manifest; the executed helper closure and binary remain the separately bound b52e artifacts.

The read-only parent witness checked actual Docker, inside-container and host identities, source identity, absence of other clients and the continuous mutex. It bound the same retained target; no second restore was substituted.

## Prelaunch failure and exact scope

`restored-inspect` then failed in PREP `assertParity`, before any restored worker launch. The original source still matched its pre-backup seal. Parent offline comparison of all 1,469 column records found exactly 31 differing `ordinal_position` values: public.artifact19, public.knowledge11, public.completion_evidence1. Row order and every other column field matched. All other sealed fields—build, versions, domain, DBOS, obligations and fixture—matched too. The dropped-column holes in physical positions disappear on logical dump/restore; PREP had treated those holes as semantic schema differences.

The canonical helper parity result is retained as a successful layer. The failed PREP gate is also retained and not waived; no restored-inspect or reopen PASS is claimed. Both source and target were stopped and retained. At 2026-10-09T18:31:15.707871Z the parent checked owner/token, original four IDs/images/start times/health, the entire running set and release hash, then released the lock and notified5796. No provider, main worker, queue replay or deployment operation occurred. Run01–10 must never restart.

[Versioned run10 evidence](evidence/2026-10-10-yuk1359-parent-restore-attempt10.json) binds 55 local artifacts and includes helper exits, canonical comparison, target witness, exact column delta, worker exits and cleanup. Raw artifacts remain in `/tmp/yuk1359-dbos-restore-offline-prep-v5/runtime/yuk1359-restore-run10` and `/tmp/yuk1359-restore-reopen-parent10`.

## Next bounded implementation

Sole task `yuk1359-logical-column-parity-prep-repair-20261010-v1` uses Codex gpt-6.1-sol xhigh and owns only a new v6 of the existing temporary PREP. It must preserve visible column order, names, types, defaults, nullability and strict membership when comparing logical source/restored schemas. Same-endpoint immutability must continue comparing the raw schema. All cross-target consumers, including post-reopen assertions, need the same correct semantics; raw snapshots and the mandatory canonical helper gate stay intact. Offline negative cases must reject real schema/data/evidence changes. The worker, helper, dependencies and historical attempts are read-only. This is fixture implementation, not a third review round.

YUK-1359 remains In Progress. This follow-up belongs to the existing restore obligation, so no duplicate ticket is needed. Judge-specific recovery, provider acceptance, all-family migration and old-runtime retirement remain separate unfinished gates.
