# YUK-1358 Start agent-note implementation

The bounded non-UI consumer migration is implemented. Today reads20 and `/agent-notes` reads50 through the authenticated Start function and the existing `agency/public.loadAgentNoteBoard`. Source, unit, installed serializer, static and build checks passed. DB, real RPC and browser acceptance remain unrun and belong to the parent. This report does not establish full migration, CI, deployment or runtime acceptance.

Workspace: `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`. Branch: `feat/yuk-1358-start-agent-notes`. Starting HEAD: `7503e0d3aa082f36e91bc726161a32d83d849a0e`. Main base and verified merge-base: `10df1a47179fe2e368f5df1a538e1dd11cf9e6da`. No branch switch, push, PR, merge, delegation or parent planning edits occurred. The final delivery commit is returned to the parent separately, avoiding a self-referential commit hash here.

## Behavior and ownership

The approved scope document quotes `docs/design/2026-10-06-continuous-learning-system-behavior.md:313`: "团队内部分析、用户可见建议和已经生效的安排必须区分。生成了一项建议不等于用户已经接受，更不等于已发生学习。" Agency guidance calls notes "hints not facts". Component types remain the existing page and route. Neither page's JSX changed. Grouping, filtering, reference navigation, unknown-kind fallback, expiry display and localStorage effects retain their original implementations.

The function's input validator is identity-only. Its handler uses the existing explicit `runAuthenticatedStartWorkbench` guard in addition to global Start request/function middleware. That guard calls Hono `/api/auth/check` with the caller's headers and keeps the token/epoch denial. No domain import, parsing, clock sample or DB acquisition occurs before that explicit guard succeeds. Function names confer no authority.

The reader samples `now` once, then imports the canonical agency public entry. It uses the exported input schema before acquiring its own DB, keeping the canonical400 issue text. It calls `loadAgentNoteBoard(database, input, now)` with the original input. Domain validation, default20, maximum200 rejection, expiry selection, enrichment and ISO projection remain domain-owned. There is no copied selector, aggregate, HTTP callback or mutation. Db/Tx and clock injection are available for verification. Errors are shaped beside the read in the Start ESM bundle.

One agency client context is consumed by both pages and supplied by the existing Start workbench shell. It uses `authenticatedStartFetch` and the existing response schema, whose row/ref passthrough retains unknown nested fields. Vite development retains the HTTP default. Today keeps `['agent-notes', 'board']`,20 and its canonical cold-start gate; the full page keeps `['agent-notes', 'full']` and50. A new Start route owns the deep link; production legacy navigation uses the existing document handoff. RootShell Copilot and other remaining HTTP requests are outside this change.

Owned source/test files, all included in `source_files` in the hash manifest:

- `server/start/agent-note-reader.ts`, `agent-note-read.ts`, `agent-note-function.ts`, `agent-note-client.ts`, `agent-note-test-fixtures.ts`, `agent-note-read.unit.test.ts`, `agent-note-client.unit.test.ts`, `agent-note-reader.db.test.ts`.
- `server/start/routes/agent-notes.tsx`, generated `server/start/routeTree.gen.ts`, and minimal `server/start/workbench-shell.tsx` provider injection.
- `src/capabilities/agency/ui/agent-note-client.tsx`, `src/capabilities/agency/ui/page.tsx`, `src/capabilities/agency/ui-public.ts`, and minimal `src/capabilities/shell/ui/TodayPage.tsx` query injection.
- `web/src/router.tsx`, `web/src/routes/WorkbenchPages.start.unit.test.tsx`, and the agent-note-only additions to `tests/usability/start-rpc-fixtures.ts` / `start-rpc-fixtures.unit.spec.ts`.

Agency public/domain/server/contracts/manifest/jobs, package/lock, test-selection configuration, workflows, migrations/schema, durable/session/boss files, worker/startup and parent PLAN/remember/control reports are unchanged. No extra source scope was needed. New unit/DB files match the existing `server/**/*.unit.test.ts` / `server/**/*.test.ts` selection conventions. The serializer case extends the existing explicitly executed Node protocol spec. Partition audit reports zero unmatched files and zero unmocked DB imports in the unit lane.

## Executed evidence

Commands, exits and log references are in [commands.json](evidence/yuk1358-start-agent-notes/commands.json). The Node executable is `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin/node`; direct and `pnpm exec node --version` both returned `v24.19.0`. Every pnpm check prepended this installation to PATH; installed CLI shims resolve `node` from PATH. Dependencies and host settings were not changed.

| Check | Result | Log |
| --- | --- | --- |
| First scoped unit |29 tests,3 files; exit0 | `unit-first.log` |
| Final scoped unit, including existing auth/workbench/domain/inventory checks |127 tests,8 files; exit0 | `unit-final.log` |
| Installed Start client/Seroval protocol, no listener or network |10 tests; exit0 | `protocol-first.log` |
| Typecheck, root and Start programs |exit0 twice | `typecheck-first.log`, `typecheck-final.log` |
| Scoped Biome |18 files, no warnings; exit0 | `scoped-biome.log` |
| Full lint |exit0 twice,290 repository warnings both runs | `lint-first.log`, `lint-final.log` |
| Full `pnpm build` |exit0, SPA + Start + server/worker/migrate bundles | `build-first.log` |
| Ten source audits |all exit0 | `audits-results.json` and corresponding logs |
| Whitespace check |`git diff --check`, exit0 | recorded in command manifest |

The ten audits are schema, partition, API client, API client usage, capability boundaries, provider lanes, profile, task census, draft status and draft status reads. Build retains warnings about chunk sizes, ineffective dynamic imports and existing Vite configuration. Unit runs retain Vite's native-config warning. No validation command failed. Initial formatting reported an unused Today HTTP import; it was removed and the final scoped check is clean. Lint's repository warning count did not increase. The source-only final test/fixture edits occurred after the full build; executable production source has not changed since that build.

New unit cases prove401 for missing/empty/wrong tokens and503 for a fenced epoch before input parsing, domain import, DB access or selector invocation. They cover malformed input, canonical400 text, default/20/50/200, injected DB and clock, long multilingual Markdown, zero confidence, optional fields, known/missing/unknown refs with nested provenance, ISO strings, empty reads and sanitized failures. Client cases retain token headers,401 re-gating and400/503 ApiError details. Page cases compare settled HTTP/injected markup on both pages, preserve separate query caches and cold gating, filter unknown kinds, restore shared local read marks, and exercise error/retry/empty behavior. Mocked selectors do not prove real DB selection or expiry.

The protocol case resolves the built function map and uses Start's installed fetcher and serializer. It verifies default/20/50/200 payloads and the complete ISO/nested-ref DTO through an offline transport. The fixture adapter's HTTP-shaped mapping is test-only; production calls the domain read directly. Offline fulfillment is not an actual server RPC.

Self-review results are in [source-review.json](evidence/yuk1358-start-agent-notes/source-review.json). The emitted function chunk has only infrastructure imports at module scope, dynamic agency/DB imports within the guarded reader, the canonical call and identity validator. The resolver imports that chunk lazily. Both pages' JSX suffixes are byte-identical to the starting HEAD; durable/localStorage implementations and domain code are unchanged. All17 recorded source/artifact assertions passed. This is author self-review; the parent's independent review is still required.

Source/test manifest SHA-256: `bc707b29a7d70275e1f5dd376c3713cad3ebe9c232858a66c21549e2e980f6ba` across19 files. Built artifact manifest SHA-256: `96604d5ba1c43a0c2d5e248daccb360132118e015966e2763b58ad1314c1b6dd` across878 files. [hashes.json](evidence/yuk1358-start-agent-notes/hashes.json) contains every path/hash. Manifest digests hash the sorted compact JSON path/hash map. Build artifacts remain local ignored outputs; hashes and logs are committed evidence.

## Prepared acceptance, not executed

`server/start/agent-note-reader.db.test.ts` contains four prepared real-DB cases. They reuse the delivered domain test's rich fixture structure, compare Start/public/HTTP output, prove an injected Tx sees nonzero uncommitted rows while the separate Db sees none, hash/count every public table before/after reads, and require fixture rollback. Cases include resolved/open/missing knowledge and active/null/future/draft/blank/missing questions, nested unknown refs, long text, exact expiry boundary, no expiry, source fallbacks,205 rows for default20/20/50/200 and above200 rejection. These are prepared assertions, not DB evidence.

Parent-only recipe after explicit runtime authorization and fresh lock acquisition:

1. Verify the returned commit, owned-file hashes and exact build artifacts. Rebuild with Node24 if any executable source changed. Run the independent review on the real diff.
2. Under a separately authorized isolated DB run, execute `PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH pnpm vitest run --config vitest.db.config.ts server/start/agent-note-reader.db.test.ts`. Record actual transaction visibility, all-table snapshots and rollback results. Do not infer these from unit mocks.
3. Supply a fresh isolated DB/token/port to the parent-owned `server/start/acceptance-server.ts`, then launch it with `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin/node --import tsx server/start/acceptance-server.ts`. That entry uses built Start and retained Hono without worker recovery. This author did not launch it or change those environment values.
4. Resolve `getStartAgentNoteBoard` from the exact emitted resolver, rather than granting authority by its name. Use the installed Start serializer/fetcher against the real loopback RPC. On the current artifact its ID is `1fad3216afa22f42733756f3cf8bee84d0a0478c29b8de170a59f87718a84ca4`. Verify missing/wrong token401 and fenced503 with malformed data before reads, then valid default/20/50/200 and malformed/out-of-range400. Compare nonzero public/HTTP/actual-RPC DTOs and all-table no-write snapshots under the same isolated data and clock policy.
5. Open the actual built `/today` and `/agent-notes` deep links and navigate from a retained SPA page into `/agent-notes`. Record document/asset hashes, RPC URL/method/header and limit20/50, and the absence of `/api/agents/notes` from these Start consumers. Exercise cold gating, full filtering/grouping/refs/unknown kind/expiry, retry and401 re-gating, shared localStorage reads, reload restoration and navigation back to Today. Existing static protocol fixtures can support a separate mocked usability run with `USABILITY_BASE_URL=<isolated-built-target> PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH pnpm exec playwright test --config playwright.usability.config.ts`; that run cannot substitute for real DB/RPC behavior.

Coordinator7631 retained runtime token `bcedb44d-2d99-4261-b8c2-5bed6b456fa4`. This author did not acquire/release a runtime lock, execute DB/migration commands, use Docker/Testcontainers, launch a server/browser/worker, call providers, make paid network calls or run full `pnpm test`. No deployment was attempted. Parent runtime acceptance and exact-head CI remain outstanding.

Linear capture: no new actionable bug/follow-up was found within the owned implementation. Existing runtime obligations are part of YUK-1358 and were not relabeled as completed. The parent owns tracker and global handoff updates; no external message or parent state mutation occurred. Writing stops after the delivery response; later notifications do not authorize further changes.
