# YUK1358 Start event detail and corrections

Baseline main6212a4560; worktree `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`, branch `feat/yuk-1358-start-event-detail`. Parent5796 owns this lane. Otherthread7631 owns1394/0117 and all session-orphan/DBOS shared changes.

## Authorized behavior and pre-flight

Owner requested the complete non-UI migration with existing pages and deterministic behavior retained. The behavior design `docs/design/2026-10-06-continuous-learning-system-behavior.md:26` says: “它出错时，我能看出、纠正，后续安排会真正改变。” This slice preserves existing event evidence and append-only correction semantics; it does not claim every downstream learning projection is complete. Component type: existing page plus route, no visual redesign.

Create Start event reader/operation, authenticated wrapper, server functions, browser client, event route and scoped unit/DB fixtures. Modify observability EventDetailPage transport only, event-detail-model only if deriving wire types requires it, a narrow UI client/provider and ui-public export, Start workbench shell if needed for provider, generated route tree, web router handoff and related route/usability fixtures. Reuse public readEventDetail and createEventCorrection unchanged. Domain/kernel/public backend/manifest/schema/package/lock/DBOS/sharedboot/start-worker/shutdown are outside this lane.

## Required contracts

- Token and active epoch precede input parsing, database loading and effects. Real missing/invalid token401 and preparing/ready503, including malformed inputs.
- Retain full ISO event envelope, unknown payloads/passthrough fields, causal chain and correction status; no lossy raw Date or Seroval shortcut. Absent404, invalid400, corrupted historical data remains an error.
- Read and append commands call the delivered1380 public operations, injected database for tests. No new event writer, deduplication store or recovery owner. Each explicit invocation retains original new-ID semantics; no automatic replay after an unknown write or failed refresh.
- Existing page only exposes retract/mark_wrong/restore; server supports supersede with replacement requirement. Preserve affected refs, reason trimming/validation, created receipt and canonical location metadata where applicable. Do not silently add a supersede UI.
- Preserve query keys, onBack/deep links, error/404 rendering, busy guards and invalidation. Vite-only HTTP adapter remains transitional; production legacy event route hands off to Start. No styling/copy redesign.

## Acceptance and ownership

Author source-only: realistic scoped unit and protocol tests, prepare scoped DB tests but do not run DB/Testcontainers, typecheck/lint/build and required audits. No full pnpm test. Parent later runs isolated actual DB and built RPC/browser under the runtime mutex, verifies whole-table no-write reads/rejections and append-only corrections, refresh-without-replay, auth re-gate and navigation. Independent review and exact-head CI precede merge. Shared deployment remains Agent TEST ONLY; this lane does not deploy.

Linear1358/1359 remain In Progress. Existing1380 owns the delivered domain slice; no duplicate issue for this consumer work. Capture proven new defects in existing scope or a deduplicated follow-up.
