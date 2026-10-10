# YUK-1358 Start admin controls implementation evidence

This lane implements `/admin/config`, `/admin/subjects` and `/admin/subjects/$id` from `f80d47703`, with the parent plan commit `fcfd7907ffe65f050bc51ae8acfc3f8b51b403dd` as its working baseline. The branch is `feat/yuk-1358-start-admin-controls` in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`. The final implementation commit is supplied in the terminal handoff. The parent-owned plan and handoffs are unchanged.

The three routes reuse the existing surfaces and shell. Their injected Start client covers all eighteen operations: config read/write/reset; subjects, bindings, catalog and journal reads; rename, retire, restore, reset and validate subject commands; and edit-subject, fork, rebind, edit-shared, rollback and reset-to-seed trait commands. Nested panels receive the same client. Retained Vite consumers default to the existing HTTP API. Production Vite routes hand off documents to Start; settings remains available through the existing navigation. No capability manifest or HTTP route was added.

The RPC boundary checks token and epoch before invoking the context resolver or parsing domain input. Parameter validators are identity functions. The host adapter then uses the already public operations with an owned `Db`; it never supplies a transaction handle or hydrates after a public mutation. It preserves CAS details, conflict without `currentRevision`, validation `issues`, missing-payload 422, general restrictions, COW, shared fanout, noops and postcommit failure semantics. Edit/fork receipts retain 200/201 and canonical journal location; the other four trait receipts omit that location. Journal reads retain the complete collection envelope, default 100, cap 200 and opaque cursor. Config receipts are recorded before read refresh, and refresh failure does not replay a write or imply worker acknowledgment. The editor still accepts degraded object payloads for repair.

## Canonical boot identity

`server/frontdoor.ts` supplies a lazy `adminControls()` resolver from the initialized host graph. It retains only the operation binding promise. Each operation reads the current host facts, snapshot and writer; no additional config cache or writer is constructed. Start's control handler graph has no domain value import. Only DTOs cross the RPC boundary.

The identity unit uses the real frontdoor context, then resets Vitest's module registry to construct a second domain graph. The duplicate has null facts, snapshot epoch 0 and unavailable writer 503. A Start call using the retained host context still observes injected facts and hot snapshot epochs 71 then 73, calls the host writer exactly once, preserves a host `ApiError` despite different class identity, and excludes the secret canary from the DTO. An uninjected host still reports `facts_injected:false` and 503 honestly.

The static emitted-byte proof is [bundle-identity.json](evidence/2026-10-09-yuk1358-start-admin-controls/bundle-identity.json), reproducible with the adjacent [bundle-identity.py](evidence/2026-10-09-yuk1358-start-admin-controls/bundle-identity.py). All twelve checks passed. In this `dist/server.cjs`, the control adapter and both bootstrap injections use `(init_public9(), public_exports5)`. Bootstrap and controls acquire `(init_client12(), client_exports5)`. Config hydration and the read model use the single host store. Bootstrap awaits hydration and injection before opening the frontdoor. The emitted Start control chunk calls `context.adminControls()` after the existing authenticated gate, contains eighteen handlers and sixteen identity validators, and the resolver contains every control function exactly once. The canonical operation factory is absent from Start server and browser JavaScript. Other retained Start consumers may still contain duplicated domain modules; these controls do not consume their singleton state. This proof reads bytes and does not execute a built server.

## Completed offline validation

Every command below ran in the named worktree with Node `v24.19.0` and pnpm `11.13.1`, using:

```sh
export PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH
```

The scoped unit command passed 406 tests in 18 files:

```sh
pnpm vitest run --config vitest.unit.config.ts \
  server/start/admin-control-read.unit.test.ts \
  server/start/admin-control-reader.unit.test.ts \
  server/start/admin-control-identity.unit.test.ts \
  server/start/admin-control-client.unit.test.ts \
  server/start/admin-read.unit.test.ts \
  server/start/admin-client.unit.test.ts \
  server/start/auth.unit.test.ts \
  server/frontdoor.unit.test.ts \
  web/src/routes/AdminControls.start.unit.test.tsx \
  web/src/routes/AdminPages.start.unit.test.tsx \
  web/src/router-lazy.unit.test.ts \
  web/src/surface-inventory.unit.test.ts \
  src/capabilities/observability/ui/config.render.unit.test.tsx \
  src/capabilities/observability/ui/config-task-editor.unit.test.tsx \
  src/capabilities/observability/ui/subject-traits.unit.test.tsx \
  src/capabilities/observability/server/admin-config-operations.unit.test.ts \
  src/capabilities/observability/server/subject-control-operations.unit.test.ts \
  src/capabilities/observability/server/trait-control-operations.unit.test.ts
```

The remaining commands each exited 0:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm exec tsx --test tests/usability/start-rpc-fixtures.unit.spec.ts
pnpm audit:capability-boundaries
pnpm audit:partition
pnpm audit:api-client
pnpm audit:schema
pnpm audit:api-contracts
pnpm audit:api-client-usage
pnpm audit:provider-lanes
pnpm audit:architecture-deepening
pnpm audit:agent-control-plane
pnpm audit:provider-attempt-truth
pnpm audit:profile
pnpm audit:task-census
pnpm audit:draft-status
pnpm audit:draft-status-reads
python3 docs/planning/evidence/2026-10-09-yuk1358-start-admin-controls/bundle-identity.py
git diff fcfd7907ffe65f050bc51ae8acfc3f8b51b403dd --check
```

The protocol fixture suite passed 9 tests using the installed Start serializer and the emitted function map, including all eighteen controls, Unicode/path encoding, nested payloads, query/cursor forwarding and retained HTTP 201/Location to RPC receipt mapping. It does not start a browser or server. Typecheck includes the new DB test source. The full build emits web, Start, server, worker and migration artifacts without running them. Lint exits 0 with 290 warnings. Partition audit reports zero unmatched tests and zero unmocked DB imports in unit tests, with six repository warnings. Capability debt stays exactly 433/0/48. The API generation audit leaves the generated client unchanged. SourceMap route gates now count eleven production document handoffs.

The [seal](evidence/2026-10-09-yuk1358-start-admin-controls/seal.json) lists every owned source/test path with SHA-256, the exact check commands/results and compressed final logs with both original and archive digests. It also seals the regression test inputs and all 868 emitted build files through the compressed build manifest. The seal omits its own digest; its final digest is supplied in the terminal handoff. Evidence is source, unit, serializer and static build evidence only. No full `pnpm test`, DB test, Docker/Testcontainers, service/port, browser, provider, paid call, replay or deployment ran.

The initial staged whitespace check detected an extra blank line at the end of the proof JSON. Commit `608f36eb3` was created before that result was inspected. The evidence-only correction removes the extra newline from the generator and report, reruns all twelve static assertions, reseals their digests and checks the complete diff from the working baseline. Product source and the successful unit/typecheck/lint/build/audit inputs are unchanged.

## Parent verification after lane release

The seven new cases in `server/start/admin-control-reader.db.test.ts` are authored and typechecked but **unrun**. They use real public operations, SQL and hydration with an owned pool, a distinct observer connection and an isolated registry. They cover full HTTP read parity and bounded journal reads; denied/general/CAS/missing-payload no-write checks over twelve explicitly named tables plus `subject_change_seq`; COW commit visibility before one hydrate and noop; fork/rebind plus all five subject commands; shared fanout/rollback-forward/reset lineage; a real postcommit hydrate SQL failure preserving the committed mutation and last-good registry without retry; and canonical config set/reset receipts with atomic secret-key rejection. The connection/registry seams are replaced; domain writes remain real.

Under the parent's DB lock and isolated database, run:

```sh
pnpm vitest run --config vitest.db.config.ts \
  server/start/admin-control-reader.db.test.ts \
  src/capabilities/observability/server/subject-control-operations.db.test.ts \
  src/capabilities/observability/server/trait-control-operations.db.test.ts \
  src/capabilities/observability/api/admin-subject-control-contracts.db.test.ts \
  src/capabilities/observability/api/admin-config-write.db.test.ts \
  src/capabilities/observability/api/admin-config.db.test.ts
```

Then verify the exact built host/frontdoor against isolated state: authenticated config read reports the host facts and hydrated epoch; writes use the injected canonical writer and return receipts; malformed payloads are denied by auth/fence before domain validation; all five subject and six trait commands preserve commit/CAS/COW/fanout/noop/rollback semantics; catalog/journal paging and serialized DTOs match the retained API. Capture any postcommit failure without replay. Browser acceptance must verify deep config query preservation, settings discoverability, nested panels, draft/CAS/fanout behavior, refresh failure receipts and production navigation with Start RPC requests. Parent independent review, exact-head CI and delivery remain separate steps. This slice does not establish full SPA fallback exit or whole-system migration completion.

No new actionable issue outside the authorized slice was found. Parent owns Linear capture/delivery state and the next DBOS lane. All domain writers/public exports, subject hydrate, agency, kernel, package/lock, schema/worker, durable/boss/session-review paths and parent planning state remain unchanged.
