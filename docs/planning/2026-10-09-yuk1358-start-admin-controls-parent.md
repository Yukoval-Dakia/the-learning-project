# YUK-1358 parent verification

The author released source608f36eb3 and final evidence eeb1ddbc4. Parent verified70 source/evidence/log hashes and868 built-file hashes. Independent R1 examines the fixed fcfd7907f..608f36eb3 diff; no verdict yet.

## Real DB verification

Six scoped files at eeb1ddbc4 ran against fresh Testcontainers DB:94 passed,1 new test failed. The failure expected reset.committed_epoch to equal prior+1. Actual config_change_seq is shared by journal and epoch and INSERT ON CONFLICT may consume multiple sequence values. The product contract is strict monotonicity, not gaplessness. Original log remains /tmp/yuk1358-controls-parent-db/tests.log.

Parent test-only commit57e6fe670 checks increasing epochs plus the authoritative database epoch, receipt changes and exact set/clear journal revisions. All7 cases in the changed file passed in a second fresh isolated DB. Combined evidence covers95 distinct cases, not101 distinct cases; unchanged88 cases retain the first-run revision. No product change was needed. Logs/lock receipts: /tmp/yuk1358-controls-parent-db-r2/.

Locks were acquired atomically for each test run. Final release17:29:51.224642Z verified owner/token, original four container IDs/images/StartedAt/health, running set and current-release bytes. First release attempt waited for the temporary container to exit rather than removing the lock prematurely. No main DB/service/provider/worker/replay/deployment operation occurred.

## Main integration

Normal merge b827f6d9a includes1392 main6aaf8ca89. Only PLAN header conflicted. Start product blobs remain exactly author source; incoming changes are the already-delivered agency note-board files. Parent integrated406unit/typecheck/lint/fullbuild/9serializer checks passed, recorded at /tmp/yuk1358-controls-integrated/. Independent review, exact-head CI and real built RPC/browser are pending. Offline preparation alone will not be reported as runtime acceptance.

Parent integrated lint caught two formatting errors in the author's final evidence JSON, which had been generated after its earlier lint run. Parent formatted only bundle-identity.json and seal.json and updated the sealed proof-file digest; product source is unchanged. The original successful author lint is evidence for its earlier input, not the final handed-off docs. Integrated lint/fullbuild/9serializer all passed after this correction.
