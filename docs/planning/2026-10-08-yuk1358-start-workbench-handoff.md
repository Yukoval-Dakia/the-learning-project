# YUK-1358 Start Today and Inbox consumer handoff

This is a source-only, non-UI slice in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`, branch `feat/yuk-1358-start-workbench`, based on clean main `6150f01a949c3d1357f8b44f0d8ed6807cd74179`. The parent owns integration, independent review, DB and browser acceptance, trackers, PR, CI and release. This writer changed no other worktree, started no service, accessed no database, called no provider, changed no queue or recovery process, and performed no external delivery action.

## Implemented behavior

- Start owns `/today` and `/inbox`, and `/` redirects to `/today`. The routes reuse the original RootShell and existing capability pages. The provider adds no DOM. Browser-local TokenGate remains in front of all page queries; anonymous SSR does not load data.
- Every new server function retains Start's request/function middleware and an explicit operation gate through the original Hono `/api/auth/check`. Original token headers and contract-epoch denials are preserved. Domain imports and the database connection are deferred until authorization passes. The only Hono dispatch is the existing authorization check, not a data/command proxy.
- Today and the shared RootShell sidebar count call `shell/public.loadWorkbenchSummary(db)`. Their unchanged `['workbench-summary']` key deduplicates the read. The overnight band and degraded flags share the canonical `loadTodayOvernightDigest(db)` read; the cost ribbon calls existing `observability/public.loadTodayCost(db)`. These domain implementations were read-only.
- Inbox decision and observation pages use `readProposalInbox`, a shared query/wire adapter around existing `listProposalInboxPage`. The original HTTP handler uses that adapter too. Default 200, clamp 500, parseInt-compatible limits, validated status/kind/lane, opaque cursor errors, and `rows/data/page/next_cursor` remain intact. The unbounded domain default is never used by the Start adapter. Progressive client bounds and diagnostics are unchanged.
- Auto-applied cards call existing `getAutoAppliedDigest(db)`. Every accept/reverse/change_type/dismiss/retract goes through `server/proposals/decision-resource.createProposalDecision`. Corrected claims retain the shared input schema and original client mapping. The canonical resource is returned unchanged, including created/idempotent flags and immutable event reference. RPC success uses the framework's response status; the retained HTTP endpoint still owns its 201/200 and Location contract.
- The existing best-effort `wakeHubSyncAfterCommit` runs after the canonical decision returns. Its slow or rejected promise cannot delay or fail the committed response. No writer, selector, dispatcher or recovery owner was introduced.
- Already-exported additional seams are wired: conjecture reads and decisions, Inbox knowledge labels with original learner-visibility filtering, recent note changes with the same 24-hour/25-row window, and note undo with the original 200-row artifact/event membership check. `skipped:version_conflict` still becomes a client 409; `already_undone` still succeeds.
- Proposal pages and decision resources use JSON strings across RPC because their existing schema permits unknown JSON fields that Start's static serializer rejects. Existing schemas parse them in the client. Nested payload, rollback, signals and decision-result data retain their HTTP JSON shape; date fields retain their ISO wire form.
- Production SPA navigation to Today/Inbox/Mistakes hands the document to Start. The Vite development fallback remains explicitly owned by YUK-1359. Unmigrated documents still use the original fallback. Mistakes retains its original reader and page; shared fetch extraction preserves token/error behavior.

There was no route or manifest contract change, so no Postman or generated API client change was required. No package, lock, capability manifest, runtime entry, kernel authorization, practice submission/scoring, Observability public/event source, or global planning/exit document was changed.

## Task-local consumer matrix and continuation ownership

This table is narrower than whole W1 completion. The global W1/SPA exit inventory remains owned by 7631/YUK-1359. Parent YUK-1358 owns route/consumer integration. YUK-1356 retains practice, judge and shared business-operation boundaries; YUK-1355/1356 retain durable execution and recovery.

| Render-tree consumer | This slice | Concrete next seam and owner |
| --- | --- | --- |
| `/`, `/today`, `/inbox`; shared shell summary | Start routes and canonical readers implemented | Parent YUK-1358 must prove document redirect, refresh, auth, epoch, navigation and actual RPC assembly on the built artifact. |
| Inbox proposal lists, auto-applied digest, all proposal decisions/retract | Canonical operations connected; progressive UI unchanged | Parent YUK-1358 must prove database outcomes, original errors, idempotency and post-commit wake on an isolated acceptance DB. |
| Today conjecture panel | Canonical public read plus shared decision command connected | Parent YUK-1358 must prove opt-in opening, edits, refusal and targeted refetch in the actual app. |
| Today recent AI changes and Undo | Exported domain read/undo connected | Parent YUK-1358 with Notes owner must prove artifact/event membership, successful undo, already-undone, and version-conflict behavior in an isolated DB. |
| Inbox knowledge labels | Exported tree snapshot connected with original visibility filter | Parent YUK-1358 must prove visible names, hidden synthetic IDs and short-ID fallback. |
| Today ProfileBand | Retains `GET /api/placement/profile?goal=...` | The API composes `resolveGoalPlacementScope` plus mastery projection; there is no exported complete profile operation. Parent YUK-1358 coordinates a typed read boundary with the Practice/1356 owner. Preserve goal scoping and stale-data/error/empty states; no mastery writes. |
| Today LearningIntentComposer | Retains `POST /api/learning-intents` | Exported `planLearningIntent` is a domain planner, not the complete validated route/budget/task boundary. Parent YUK-1358 with Agency owner must expose that command without bypassing its provider/budget policy or pending-proposal replay. Product model routes were outside this writer's scope. |
| TeachingBrief read, acknowledgement and interaction | Retains `GET /api/prep-desk/brief` and POST `/brief/ack`, `/brief/interaction`; proposal decisions now use Start | The complete load/ack/interaction contracts need a shell public seam. Parent YUK-1358 with Shell owner must retain append-only events, idempotency/day gates and fail-closed acknowledgement. Preserve current behavior until that boundary exists. |
| Active probe reads and answers, including TeachingBrief probe cards | Retains `GET /api/prep-desk/probes`, `POST /api/conjecture/probe/:id/answer` | `loadActiveProbes` lacks a public operation export. `answerProbe` is exported but does not replace the whole route's answer/photo/provenance/model contract. Parent YUK-1358 coordinates with YUK-1356. No grading, original submission, frozen provenance or execution recovery was changed. |
| Today agent-notes board | Retains `GET /api/agents/notes?limit=20` and the summary cold-start gate | Board reader `readAgentNoteBoardRows` lacks a public export; exported `readAgentNotes` has different agent-filtered semantics and is not a substitute. Parent YUK-1358 with Agency owner must expose the existing board read. Expand/fold/all-read remain localStorage-only. |
| Shared shell CommandPalette knowledge search | Retains its existing opt-in `GET /api/knowledge` | The exported tree reader is available, but the global palette has no injectable client port in this owned file set. Its owner should add that port and retain query sharing/visibility; 1359 tracks its HTTP exit. Inbox labels already use the new port. |
| Shared CopilotDock, SSE, assets and linked pages | Existing consumers retained | Parent YUK-1352/YUK-1358 and1359 own later consumer replacement;1365 streaming behavior stays intact. Probe/photo asset upload/content continue through existing authenticated asset operations. `/practice`, `/profile`, `/knowledge`, `/agent-notes`, event links and other documents remain separately owned fallback routes. |

The remaining rows are migration continuations, not newly established runtime bugs. They are already within1358/1359 and the named domain owners. No new actionable defect was found; no new tracker item is requested. The parent executes the required Linear capture/status gate. This writer was explicitly prohibited from Linear/PR/review work and did not alter PLAN or the global exit documents.

## Source verification

Node `v24.19.0`, pnpm `11.13.1`, existing main dependencies. Final formatting reported the install already up to date; package and lockfile bytes are unchanged. The [seal](evidence/2026-10-08-yuk1358-start-workbench/seal.json) contains per-file SHA-256 hashes for all 26 changed production sources, all 40 regression test files, lossless gzip archives of nine successful raw logs and 804 built files. It also defines the compact-JSON aggregate hash method. The seal records both archive and exact decompressed-log hashes. Logs contain source diagnostics and synthetic fixtures only; no token, private data, provider output or live database snapshot was archived.

| Check | Observed result |
| --- | --- |
| Scoped Start, Mistakes, Today and shell UI units | 40 files, 318 tests passed. Includes real Hono token/epoch gates; actual malformed domain-cursor validation; query defaults/caps/filter errors; rich JSON payload/results; mutation errors; non-blocking rejected/slow wake; progressive injected Inbox commands; original TeachingBrief/probe/AI-change interactions. |
| Application and Start TypeScript programs | `pnpm typecheck` passed. |
| Lint | `pnpm lint` passed with 297 warnings. No unsafe fixes were applied. |
| Full source build | `pnpm build` passed for SPA, Start client/server, app, worker and migrate bundles. No bundle was started. |
| Partition and capability boundaries | Passed; no unmocked unit DB import or deep cross-capability import. |
| API contracts/generated client | Passed; 173 declared operations, generated client unchanged. |
| Render-tree comparison | The existing Today and RootShell settled DOM matched between HTTP and injected clients after normalizing only React useId values. The test also proves one shared summary and replacement of primary HTTP reads. The cold-start test proves notes stay gated. This is DOM fixture evidence, not visual/browser acceptance. |

No independent review, DB test, live RPC/browser acceptance, full local `pnpm test`, exact-head CI, merge or deployment was run or claimed. Existing mock seams establish adapter contracts, not real database effects or provider quality.

## Parent DB and runtime acceptance recipe

1. Acquire and verify the existing runtime/deployment lock. Resolve release metadata and verify an isolated synthetic acceptance database identity before any service or fixture mutation. Keep private/user databases and the current app/worker deployment untouched. Use the parent-owned isolated PG/container setup and record its actual host/port; this slice neither reserves nor changes a DB port.
2. Run the relevant existing scoped DB suites under that lock, using the normal isolated DB-test setup: shell `api/workbench-summary.db.test.ts`, `server/overnight-digest.db.test.ts`, `api/proposals.db.test.ts`, `api/proposal-decisions.db.test.ts`, Notes `api/ai-changes.db.test.ts`, Observability `server/today-cost.db.test.ts`. Verify query default 200/cap 500, equal-rank/time cursor continuation with no duplicates, lane/status/kind filtering, decision replay/conflict and undo-window behavior. Do not replace real checks with these unit mocks.
3. Verify the candidate source and built-file hashes against the seal. Confirm loopback port 18952 is free. From this worktree, use the existing acceptance entry with only parent-held acceptance environment values:

```bash
env -i HOME="$HOME" \
  PATH="/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  TMPDIR=/tmp NODE_ENV=production API_PORT=18952 \
  DATABASE_URL="$YUK1358_ACCEPTANCE_DATABASE_URL" \
  INTERNAL_TOKEN="$YUK1358_ACCEPTANCE_TOKEN" \
  pnpm exec tsx server/start/acceptance-server.ts
```

This is a recipe, not an executed command. The entry binds `127.0.0.1:18952`; built Start documents, RPC, retained API and fallback assets share that port. There is no Vite dev server in this production-frontdoor acceptance. Vite `:5173` and normal API `:8787` are only the separately owned development fallback/current app ports, not proof of these built routes.

4. In the T3 preview, open `http://127.0.0.1:18952/`, direct `/today`, `/inbox`, and `/mistakes`. Verify the root redirects to Today; direct reload, deep links and navigation from a retained SPA page hand off to Start. Capture the built document/chunk provenance. Exercise missing/wrong/expired tokens and authenticated fenced epoch before reads/commands; confirm no business write and no loader/command runs when denied. Capture the original 401/503 error bodies and retained re-gating/retry behavior.
5. Seed only parent-owned synthetic fixtures: empty and nonempty learning evidence; multiple currencies plus reported/estimated/legacy/unknown/zero cost; quiet and active overnight windows; more than 500 decisions plus observations with equal rank/time; pending/corrected/retracted proposals; reversible and conflicting note changes; visible/synthetic knowledge labels. Compare canonical-reader and retained-HTTP JSON with real Start output. Record network calls proving primary reads/commands use `/_serverFn/...`, while each retained descendant in the matrix remains explicit. Check independent loading/errors, stale/error state, cursor diagnostics, shared summary count, cold start and notes gate.
6. Test decision variants against canonical persisted events: accept/dismiss/reverse/change_type/retract, corrected claim, empty invalid edit, same-decision replay, conflicting decision, not-found and unsupported/stale cases. Check exactly the expected business changes and immutable resource identity. A real after-commit wake may start the existing send-capable boss or create isolated queue metadata; record those separately from the business mutation. Do not start workers, recover/replay jobs or call a provider to establish this UI/RPC slice. Demonstrate best-effort unavailable wake separately without making success depend on it. Recovery acceptance remainsYUK-1355/YUK-1356-owned.
7. Verify note undo success, already-undone and version conflict against real artifact versions. Recheck conjecture edits/refetch and Inbox name fallback. Exercise retained TeachingBrief acknowledgement/interaction, probe queue/error and attachment paths with the domain owner's provider-free fixtures; do not submit an actual model-graded answer or a learning-intent generation without that owner's separate acceptance authorization. Confirm existing Copilot/SSE requests still use their original transport without sending a model message.
8. Snapshot the permitted tables before and after the read-only stage and classify any pre-existing navigation initialization separately. Never describe a whole navigation session as no-write if an old linked page initializes state. Capture source/revision, input/output digests, network evidence, DB deltas and log hashes. Stop only the parent-started acceptance process, verify unchanged release/services, then release the lock. Parent performs independent review, exact-head CI and tracker/global-exit reconciliation before any delivery claim.

Whole W1, old SPA/HTTP retirement, real business/runtime acceptance and deployment remain open. This handoff completes the authorized primary consumer source slice.

## R1 P1 timestamp repair, 2026-10-08

The repair starts at assigned revision `bc43bf89cb5703a49c11cd4335ac81e0447e8900` on this same branch/worktree. R1 identified that `loadTreeSnapshot` uses undecoded `sql<Date>` for `last_active_at`; the installed Drizzle postgres-js driver retains timestamp strings. Calling `.toISOString()` on a nonempty visible row therefore failed. Only the Start reader now normalizes its three timestamp fields. Driver strings remain byte-for-byte unchanged, including PostgreSQL microseconds and offsets. Decoded Dates retain ISO output. Nullable archive/evidence values remain null; invalid Dates and a missing required active timestamp retain the existing logged 500 error. Snapshot errors still propagate through the existing HTTP error shaping. There is no parsing, epoch substitution or empty-graph fallback.

The final regression tests against the baseline reader are RED with 5 failures and 49 passes. The raw timestamp case records `row.last_active_at.toISOString is not a function`. The repaired reader is GREEN with 90 tests across five scoped Start files, including 54 workbench-read tests. Both TypeScript programs, lint and the full build passed under Node 24.19.0; lint retains 297 warnings. The static partition audit passed with no unmatched test or unit DB-import error. Source hashes, final command/log hashes and the build artifact manifest hash are sealed in [the repair receipt](evidence/2026-10-08-yuk1358-r1-timestamp-repair.json). Logs and the artifact manifest are under `/tmp/yuk1358-r1-timestamp-*` on this host.

`server/start/workbench-reader.db.test.ts` is prepared and statically typechecked, but has not run. It injects only the isolated test connection; the canonical snapshot, retained HTTP handler, SQL and Drizzle/postgres-js driver are real. Its parent/child/synthetic/archived fixture includes a six-digit fractional timestamp inserted via SQL and a decoded mastery-evidence Date. It must observe an actual raw timestamp string, preserve its instant and all fractional digits, and compare the authenticated Start adapter with retained HTTP JSON.

Parent runtime recipe, after resolving the existing lock and isolated test DB boundary:

```bash
cd /Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor
PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH \
  pnpm vitest run --config vitest.db.config.ts server/start/workbench-reader.db.test.ts
```

That command invokes the normal isolated testcontainer/fork setup and resets its synthetic DB. It is a recipe, not an executed command. Parent must then use the existing built-frontdoor acceptance procedure above with a nonempty visible graph and capture the actual `getStartKnowledgeTree` RPC from Inbox. Compare its raw timestamp strings and decoded ISO Dates with `/api/knowledge`, verify visible labels and hidden-ID fallback, and retain token/epoch denials. The prepared DB test calls the authenticated adapter, not the built framework RPC; its eventual success alone cannot establish live RPC/browser acceptance.

This repair writer performed no DB/container/service/provider/network/runtime operation and no fetch/merge/push/PR/watch/Linear/review/delegation. No further actionable finding was discovered; parent retains tracker capture, the single R2 and runtime validation. Changes are limited to the reader, scoped Start unit/DB tests and this task-local handoff/receipt.
