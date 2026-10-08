# YUK1358 Start observation reads: parent acceptance

Candidate `8bfc4d20354679b6e428b38359385bcb0cdf0cab` passed exact CI Gate `37827927759`, including four unit shards, four DB shards, migration, usability and aggregate. Independent R1 found no P0/P1 against implementation `3ac84e80e`; the subsequent two test-count corrections do not change its 19 recorded source or 878 build files. Parent verified those hashes again before runtime. PR1622 is a consumer slice, not completion of YUK1358/1359.

## Observed behavior

The parent ran the installed Start fetcher and Seroval over actual loopback HTTP into the retained emitted Hono/domain graph and exact built Start. Its isolated entry tail replaces canonical boot and omits background jobs, subscription listeners, config writer injection and provider initialization. The main app/worker remained untouched.

- 26 actual RPC calls in 10 read windows: missing/wrong token401 before validation, preparing/ready503 before malformed input, default20, explicit20/50/200, string50, invalid/absent inputs400. DTOs match the real emitted public reader and HTTP route. A separate injected-clock public-reader call proves the strict expiry boundary; RPC uses the real clock.
- 205 eligible synthetic observations include long multilingual originals, nested provenance, unknown signals/references, missing optional values, expiry and unusable questions. Each read window compares the complete non-system table contents, relation definitions and sequences. All88 public tables were unchanged; no pg-boss schema exists in the isolated database.
- T3 preview showed Today20 and full-page50 through the actual Start function, with no `/api/agents/notes` request. Known and both unknown filters, today/yesterday/earlier groups and run-evidence expansion worked. Marking20 Today observations read persisted only the shared localStorage keys across full-page navigation, deep refresh and return; expansion restored. This does not assert live cross-tab synchronization.
- Four deliberately injected browser transport errors produced the error UI. Clicking Retry returned a real serialized200/50. A wrong-token request reached the server and returned401; the client cleared the token and displayed the gate. Entering the synthetic token through that gate restored a real200/50.
- A legacy `/knowledge` document served `/assets/` files. Clicking its AI观察 navigation loaded a new `/agent-notes` document with `/_build/` assets and the real50-row function. A knowledge reference opened and loaded its actual node. Three bounded browser windows, including navigation, had unchanged table contents and sequences.

T3 selector clicks twice timed out with a transient host-unavailable result; `preview_open` reattached and a coordinate click based on the inspected button rectangle completed the legacy handoff. No alternative browser was run. The acceptance-only same-origin CSP blocked external Google fonts; screenshots establish behavior/layout, not final font fidelity.

## Failed preparation and correction

The first isolated setup failed because the offline recipe guessed90 public tables. It was cleaned and its failure retained. Parent enumerated the migration journal:95 CREATE names minus7 dropped names yields88. The revised driver asserts the exact88 names as well as all non-system relations, row hashes and sequences; it does not merely lower a count gate. A fresh independent run then completed. This repair changed only ignored acceptance tooling, not product code.

## Isolation and evidence

Runtime mutex owner5796/token3593776b was held from `2026-10-08T19:07:14.406031Z` to `2026-10-08T19:15:34.481635Z`. Both exact-owned PG containers and the loopback listener were removed/stopped. The four original container IDs/images/start times/health, running set and current-release hash remained identical. Synthetic dump and private run inputs remain in the ignored recipe directory; no main data, worker, queue replay, paid provider or deployment was used.

Sanitized receipts, failure, corrected recipe, source/build seal, all RPC wire records, full snapshots and browser observations are archived in [runtime evidence](evidence/yuk1358-start-agent-notes/runtime/summary.json); manifest pins each archived file and archive digest. The archive excludes tokens, database credentials and generated executable copies. [Today screenshot](evidence/yuk1358-start-agent-notes/runtime/today.png) and [unknown-filter screenshot](evidence/yuk1358-start-agent-notes/runtime/unknown-filter.png) are separate artifacts.

Canonical boot/listener/worker behavior, personal deployment, full SPA retirement and remaining task families are not established by this slice. Task-local assertion/preparation failures were repaired and preserved under YUK1358; no new unrelated product issue was found. YUK1358/1359 remain In Progress.

## Integration with review-orphan main

Normal merge `f34e00328` includes main `e1f2ef6bb` from PR1621. Only PLAN and handoff text conflicted. Parent verified all19 recorded Start source files against the original digest and all26 incoming non-document files against main. No product conflict resolution changed either lane.

Integrated verification passed7 files/90 scoped unit tests, typecheck, lint, full build and11 post-build audits, including schema, partition, client generation/usage, capability/provider boundaries and architecture deepening. [Integration receipts and compressed logs](evidence/yuk1358-start-agent-notes/integration/checks.json) pin the tested revision. Original DB, independent review and built RPC/browser evidence retain their recorded revisions; this merge did not rerun runtime acceptance or change the shared deployment. Final pushed head still requires its own CI Gate.

Linear1358 was found Done during closeout and restored to In Progress. Remaining routes, canonical boot, task families and legacy retirement still prevent overall completion. No new product defect was found in this integration.

## Delivery

PR1622已于2026-10-08T19:35:25Z squash合main6212a4560c68c294245dc3f3e10e4f774c6ff6f8，tree a99b6bc67301aafa1b705f81f14aaca71c567c8a与exact0fbeb1f3f相同、diff空；CI37831807097全绿，R1 NONE/threads0，已unwatch。整合90unit/static/build/11audits与原DB/RPC/browser证据分层保留，未部署；1358/1359继续InProgress，1394/0117仍7631独占。
