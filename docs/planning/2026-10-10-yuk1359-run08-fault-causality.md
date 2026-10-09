# YUK-1359 run08 fault causality and repair boundary

The parent reproduced a defect in the acceptance proxy: it closes the triggering connection pair and rejects new connections, but continues forwarding on other existing application connections. The fixed product deliberately reads a committed receipt after a lost commit response. A surviving connection can therefore let it complete successfully.

This explains a valid path to run08 SUCCESS/3. Historical evidence has no connection IDs, backend PIDs or executed statement identities, so it does not prove which connection carried the run08 reconciliation. No production defect or flaky-test verdict is inferred.

## Parent verification

The parent read the actual proxy and product receipt-inspection branch, reran the research census and exact-function offline probes, and independently reread all 41 input hashes. Seven selected v2/v3 file pairs remain byte-identical. Nine case groups passed, including 95 frontend and 17 backend single-split cases. These 112 split cases are bounded protocol checks, not exhaustive fuzzing. Network connection, listener and child-process attempts were all zero. Two product control-flow cases stub external I/O and are not database acceptance.

The proxy correctly suppresses its matched COMMIT frame in these checks. The missing guarantee is an application-wide outage, together with proof that the matched transaction executed the specified receipt insert. Parse-only SQL currently arms the proxy without execution. The installed postgres.js pool selects an available existing connection before opening a closed slot; this is source and offline evidence, not a historical pool schedule.

Parent evidence: [hashes and probe results](evidence/2026-10-10-yuk1359-parent-fault-causality.json). Detailed researcher report: `/tmp/yuk1359-run08-fault-causality.md`. Rerunnable scripts: `/tmp/yuk1359-run08-causality/census.py` and `offline-probe.mjs`. Original author outputs were preserved before the parent rerun.

## Bounded repair now assigned

One T3 implementation task, `yuk1359-identity-bound-outage-prep-repair-20261010-v1`, uses Codex `gpt-6.1-sol` with `xhigh` reasoning. It owns only a fresh v4 revision of the existing temporary acceptance preparation. The repository's product, fixed worker, helper, SDK and installed dependencies remain outside its write scope. Parent owns tracked documentation and later acceptance.

The repaired proxy must bind the fault to the exact tick and first session's executed receipt transaction. On its server COMMIT response it must synchronously block every existing application pair, suppress completion, and reject new pairs. Both data directions must check the outage latch. Evidence must identify the target and affected pairs without recording credentials or backend secrets. Direct DBOS, pg-boss and observer routes remain available.

Offline checks must cover existing idle/busy pairs, queued callbacks, new pairs, prepared statement reuse, non-target input, Parse without Execute, rollback, fragmentation and coalesced completion frames. The parent driver must require the causal witness in addition to unchanged real ERROR/one receipt/two missing receipts and settlement checks. No smaller pool, disabled reconciliation, delay tuning, manual status, repeated attempts to obtain a pass, or third product review is authorized.

All v2/v3 artifacts and run01–08 sources, failed records, inputs and seals remain preserved. A new real attempt may start only after parent artifact verification and fresh runtime mutex acquisition. Run08 did not reach capture, restore or reopen; those remain unverified. The last runtime cleanup remains the run08 receipt at 2026-10-09T17:10:19.368219Z. This turn ran no runtime commands.

The existing YUK-1359 restore acceptance task covers this fixture defect; no duplicate issue is needed. The complete migration remains In Progress.
