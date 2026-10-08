# YUK-1358 parent verification

The author released source608f36eb3 and final evidence eeb1ddbc4. Parent verified70 source/evidence/log hashes and868 built-file hashes. Independent R1 completed with no P0/P1 on fcfd7907f..608f36eb3. Parent matched diff SHA256 1bf728a66c646e678a46582c43657a6b02f8c2cbc9f03ac0ab5369eb64eb80ce.

## Real DB verification

Six scoped files at eeb1ddbc4 ran against fresh Testcontainers DB:94 passed,1 new test failed. The failure expected reset.committed_epoch to equal prior+1. Actual config_change_seq is shared by journal and epoch and INSERT ON CONFLICT may consume multiple sequence values. The product contract is strict monotonicity, not gaplessness. Original log remains /tmp/yuk1358-controls-parent-db/tests.log.

Parent test-only commit57e6fe670 checks increasing epochs plus the authoritative database epoch, receipt changes and exact set/clear journal revisions. All7 cases in the changed file passed in a second fresh isolated DB. Combined evidence covers95 distinct cases, not101 distinct cases; unchanged88 cases retain the first-run revision. No product change was needed. Logs/lock receipts: /tmp/yuk1358-controls-parent-db-r2/.

Locks were acquired atomically for each test run. Final release17:29:51.224642Z verified owner/token, original four container IDs/images/StartedAt/health, running set and current-release bytes. First release attempt waited for the temporary container to exit rather than removing the lock prematurely. No main DB/service/provider/worker/replay/deployment operation occurred.

## Main integration

Normal merge b827f6d9a includes1392 main6aaf8ca89. Only PLAN header conflicted. Start product blobs remain exactly author source; incoming changes are the already-delivered agency note-board files. Parent integrated406unit/typecheck/lint/fullbuild/9serializer checks passed, recorded at /tmp/yuk1358-controls-integrated/. Exact-head CI Gate 37817401666 passed on 75c0fa149, including all four DB shards and aggregate. The runtime acceptance below uses that revision; any subsequent documentation commit still requires its own exact-head CI before merge.

Parent integrated lint caught two formatting errors in the author's final evidence JSON, which had been generated after its earlier lint run. Parent formatted only bundle-identity.json and seal.json and updated the sealed proof-file digest; product source is unchanged. The original successful author lint is evidence for its earlier input, not the final handed-off docs. Integrated lint/fullbuild/9serializer all passed after this correction.


## Built RPC and browser acceptance

Candidate 75c0fa149d903b757f6487e3105e3bfea11c7359 passed isolated acceptance. The [machine-readable record](evidence/2026-10-09-yuk1358-start-admin-controls/runtime-acceptance.json) contains artifact hashes, all RPC effect records, nine independently asserted browser database windows and the lock-release receipt. Full local evidence remains in `.cache/yuk1358-controls-built-acceptance/runs/parent-controls-r4/` and `/tmp/yuk1358-controls-built-parent/`; the synthetic final database dump is retained locally, outside Git.

The installed server-function client and Seroval exercised the actual built resolver through the emitted host graph: 18 operations, 122 calls and 35 RPC windows. A separate read-refresh window verified that a committed configuration write was not repeated. Missing/wrong authentication returned 401 before input validation; preparing/ready epochs returned 503. Coverage includes complete DTOs, 206 journal revisions with unique descending cursor pages and 100/200 limits, validation, forbidden general-subject changes, CAS/name conflicts, noops, COW, explicit fork, rebind, shared fanout, rollback-forward, reset and atomic configuration rejection. Injected hydration failure preserved the committed receipt and last-good snapshot; explicit refresh performed only reads.

Real browser interactions covered the three pages, authentication/re-gating, settings navigation/deep link, nested catalog and history, copy-on-write, retire/restore/reset confirmations, and two-tab stale CAS rejection. Configuration reset deliberately exhausted read retries after one successful write: the page reported the committed state and failed refresh, then recovered through the explicit refresh button without another write. The browser database comparison checked all 90 snapshotted tables and five sequences, with exact expected changes for writes. Navigation, stale rejection, read refresh and the final read-only pass changed neither rows nor sequences. These are scoped window claims, not a database-wide no-write claim for the whole session.

T3 preview handled the interactive writes. It then returned an explicit automation-host-unavailable error. Only after that error did a standalone installed Playwright browser perform read-only history and configuration deep-link checks. The legacy journal UI displays its first 100 rows and has no next-page control, as already recorded in the W5 inventory; the 206-row pagination proof belongs to RPC, not browser pagination. Existing Google Fonts requests remained blocked by CSP with a usable fallback. Both observations remain in the existing YUK1358/1359 scope, with no new duplicate ticket or CSP relaxation.

Three failed recipe runs remain preserved. The first assumed partial trait overrides should validate; the existing enum-record contract fills absent kinds with undefined and returns valid=false. The repaired fixture also supplied all six bound payloads and verified valid=true. The second raced PostgreSQL's temporary startup socket; readiness now checks TCP. The third synthetic role omitted sequence UPDATE permission required by the existing setval call; only the isolated role grant changed. None required product changes. Failed snapshots and logs were retained rather than presented as passing runs.

## Runtime boundary and cleanup

The controller retained the emitted bundle prefix/helper bytes, removed the automatic startup tail, then invoked its emitted subject/config hydration, writer/facts injection and frontdoor with the actual built Start resolver. Its byte hashes and omitted calls are recorded. This proves the isolated graph and controls; it does not prove automatic canonical bootstrap, background refresh, listener or worker startup, worker acknowledgment, provider quality, deployment or full SPA retirement. No provider request or job replay occurred.

The parent held the runtime mutex from 2026-10-08T17:50:03.820026Z until 18:01:35.907845Z. After stopping/removing only the isolated app/PG, it checked the owner/token before releasing the lock. The original four containers' IDs, images, start times and health, the running-container set and release bytes were unchanged. The main environment remains Agent TEST ONLY at source5aa2/image9b76. T3 tabs were inaccessible after its host disconnected; their isolated server and database were removed. No live deployment occurred.

YUK1358 was observed incorrectly Done and restored to In Progress after this slice. Remaining routes, canonical boot, task families and legacy exits remain open. PR1620 is ready for final evidence CI and merge; source review is not reopened for documentation-only changes.
