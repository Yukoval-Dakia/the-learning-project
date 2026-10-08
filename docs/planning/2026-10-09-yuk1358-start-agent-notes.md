# YUK1358 Start agent-note board consumers

## Goal and ownership

Continue the authorized non-UI migration from main10df1a471. Today and the full agent-notes page must call the delivered YUK1392 public read through authenticated, epoch-gated Start, preserving current visuals and behavior. This is the existing YUK1358 consumer scope, not a second domain implementation or completion of the whole migration.

Thread57961995 owns one source writer in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`, branch `feat/yuk-1358-start-agent-notes`. Thread7631 owns YUK1393 and the runtime mutex tokenbcedb44d-2d99-4261-b8c2-5bed6b456fa4. No DB/Testcontainers/browser/server/worker/provider or runtime operation until explicit release and a fresh parent lock acquisition. Unit tests must not launch services.

## Retained behavior and pre-flight

Design `docs/design/2026-10-06-continuous-learning-system-behavior.md:313` says: “团队内部分析、用户可见建议和已经生效的安排必须区分。生成了一项建议不等于用户已经接受，更不等于已发生学习。” Agency AGENTS defines these notes as “hints not facts”. This change preserves the read-only observation surface and localStorage read marks, with no proposal acceptance or database writes.

Component type: existing page and route; preserve all JSX layout, styles and interaction copy. Mechanical client injection only. Today keeps its cold-start gate and limit20/query-key board; the full page keeps limit50/query-key full, filtering, grouping, expiry/reference display and local read marks. Public input defaults20 and rejects values above200 instead of clamping. API history stays available to Vite-only consumers until the documented full migration exit.

Owned paths: dedicated `server/start/agent-note-*` modules and scoped tests; `server/start/routes/agent-notes.tsx`, generated route tree, Today route or workbench shell/client only as needed for injection; `src/capabilities/agency/ui/page.tsx`, a minimal UI client module and `ui-public.ts`; Today minimal client injection; `web/src/router.tsx` production handoff; relevant existing Start/usability tests and fixtures. Product registration remains existing UI surface. Original agency public/domain/selector/contracts, jobs, schema/migrations, lifecycle/worker, package/lock, workflow and vitest.shared are read-only. Ask parent for a necessary scope addition, not for normal implementation permission.

## Implementation and evidence

Reuse `agency/public.loadAgentNoteBoard(database:Db|Tx,input:AgentNoteBoardQuery,now:Date)` after Hono token/epoch authorization. Sample the clock once; domain owns selection, expiry and enrichment. Preserve explicit ISO DTO fields, unknown signal kinds and unresolved references. Use installed Start serialization and the established ApiError transport; do not substitute an HTTP callback for the domain function or eagerly access DB before authorization.

One T3 implementation child uses provider codex / gpt-6.1-sol / reasoningEffort high. It may run scoped unit, typecheck, lint, build and source audits, prepare real DB fixtures, and commit only owned files. It may not run DB/migration/runtime/browser/provider checks, push/PR/watch/merge or delegate. Parent verifies artifacts, commissions an independent source review, and later runs isolated transaction/full-table no-write and real built RPC/browser acceptance under the shared mutex.

Required cases: missing/wrong token401 and fenced503 before input/domain; malformed/out-of-range400; default20/Today20/full50; injected DB and single clock with nonzero fixtures; long/nested/unknown/expired/ref-enrichment DTO parity; empty/error/retry/re-gate; shared local-only read marks; no HTTP notes request on actual Start consumers; production deep-link and legacy navigation handoff. Full migration/worker/provider/deployment remain separate claims.

Status: source3ac84e80e / evidencec10e11885 delivered, writer completed/noPending. Parent verified19 source,878 artifact and the recorded evidence hashes. Author127unit/10serializer/typecheck/lint/build/10audits passed. Parent ran3files14DB successfully, including4 new Start cases with nonzero Tx isolation, full-public-table no-write comparisons, rollback and HTTP/domain parity. Runtime mutex released2026-10-08T18:45:27.211772Z after confirming original4/running set/release unchanged; no provider/worker/replay/deploy. R1 completed/noPending with NONE P0/P1; parent verified reviewed diff SHA `6c92b188de317273c04de816123936fb4e36d0c62f6d674ed1017512c9896336`. Ignored built-acceptance preparation is separate. Actual built RPC/browser and exact-head CI remain unproved. Parent proof: evidence/yuk1358-start-agent-notes/parent/.

## CI assertion repair

CI37826987461 at3a9b09291 failed eight tests in two old admin suites: the production handoff total remained asserted as11 after `/agent-notes` raised it to12. Parent reproduced8 failures/39passes, changed only the two counts, and reran four scoped files:59/59 pass; focused Biome exit0. All19 recorded source files and878 build artifacts still match. No product logic or runtime change, no repeat DB/build or independent review needed for this mechanical assertion repair. New exact-head CI and real built RPC/browser acceptance remain required. Logs and hashes: `evidence/yuk1358-start-agent-notes/parent/ci-handoff-repair.json`. Task-caused failure belongs to existing YUK1358; no separate defect ticket.
