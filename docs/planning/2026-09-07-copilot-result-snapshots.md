# YUK-966 — Deliver the nominated result, not its tool name

## Scope and product contract

The owner approved modifications to the existing Copilot drawer's send,
recovery and message presentation. This change completes result presentation
inside that drawer; ADR-0062's single persistent conversation lifecycle remains
unchanged. Closing, refreshing or disconnecting does not cancel execution.

Design basis: `docs/design/2026-06-09-copilot-presentation-layer.md` §2.2
“hero 卡 → 完整密度（full result + actions + 展开）”, §2.3 “已存在的” result,
“不重复取数”; ADR-0061 preserves the agent's post-result nomination. Later
ADR-0062 supersedes the old document's foreground/background lifecycle.

## Ownership

- The model nominates a reference only. The control rejects supplied snapshots.
- The existing finalizer captures independent copies of DomainTool observations
  and binds the result to a succeeded, executed root call with matching name/ID.
  Child, failed, in-flight, unknown or control-only references do not publish data.
- The result projector explicitly classifies every current Copilot/chip tool.
  Typed readers reuse registered domain output schemas, including existing
  redaction, correction and evidence boundaries. It does not duplicate those
  schemas or use a global field-name filter. Mem0 passthrough, opaque attribution
  and raw FSRS fields receive explicit narrowing; generated questions publish
  task-owned normalized fields; write/proposal results publish stable receipts,
  not HTML/diagnostics.
- Public JSON is capped at 32,000 UTF-8 bytes. Natural result lists may omit
  complete trailing entries with a separate count; original coverage and totals
  remain intact. Atomic content is never clipped into a misleading fragment.
  Missing history, unavailable results, real empty arrays, false, zero and null
  remain distinct. Optional JS undefined follows the existing JSON wire behavior.
- Generated outlines join the existing learning-validation surface. Question
  candidates always run the existing independent question/solve/teaching checks,
  even when their JSON contains no question mark or the reply has no manifest.
  The task owner resolves subject/scope and parses its existing output contract;
  no second draft, hidden marker or copied validator schema is introduced.
  Ordinary reads do not add model calls. Snapshots never enter model history.
- One pure DTO/parser serves finalization, API contracts and client live/replay.
  The existing commit/outcome/REPLY/history chain persists that same snapshot.
  The drawer uses ToolUseCard, inert text and native expansion; it never fetches
  tool results again. Existing artifact/HTML carriers are unchanged.

The new projector reads the existing DomainTool registry: one legitimate
`copilot -> ai` dependency (11→12; total 438→439). The baseline records this
runtime contract reuse, not a new cross-business writer exemption. No new
capability cycle or writer allowlist entry was introduced. A shallow forwarding
wrapper solely to conceal the edge was rejected.

## Verification and delivery state

- 78 scoped unit tests and 108 scoped DB tests passed before final review;
  includes production-shaped evidence and the actual registered domain contracts.
- Worker integration deliberately fails terminal projection once, repairs it,
  and verifies identical domain event, returned result, job REPLY and history
  snapshot; model execution stays at one. The new history assertion initially
  exposed an absent test session; seeding a real Copilot session fixes the fixture
  without weakening the reader or deleting the assertion.
- 20 built-SPA browser regression cases passed, including live/refresh result
  content, zero/null/false and no repeated submission/result request.
- Local typecheck, lint, build, API contracts, generated API client/Postman,
  partition and learner-copy checks passed. Lint retains existing warnings.
- Initial independent review found one P1: raw generated JSON bypassed the
  prose-based content gate. The typed candidate path above fixes it; 16 actual
  contract DB tests and 52 focused unit tests passed. Sole verification at
  947be81c passed (independent 45 unit/16 DB); review budget is closed.
- Initial CI at f439a0be failed one obsolete migration-only schema fingerprint;
  the eight real tool permission/composition cases remain, frozen hashes do not.
  Final exact fefcf70e1a07b4ef554deb3d4c1b9eab4a1401fa passed every job in
  CI Gate34059429533; PR1348 squash merged main5cf5dccab207c32b47b6ddb15163dff10c379080
  at2026-09-06T21:05:27Z. YUK-966 is Done; the overall goal remains active.
- Actual read at clean f439a0be delivered the identical 1,236-byte snapshot live
  and persisted: two knowledge nodes, real null/zero/parent/coverage preserved.
  One root, one read and one nomination; input 41,280 / output 360; estimated
  $0.0039958367. This is delivery PASS, not a token-saving comparison.
- Manual prose review is PARTIAL: the model additionally claimed no recent
  failures, although that optional field was not queried. Deduplicated YUK-967
  tracks reader-owned observation scope; the original output remains sealed in
  evidence/2026-09-07-tool-result-snapshot-actual.json.
- Candidate actual at clean 947be81c is NOT ACCEPTED: the fail-closed validator
  dropped its card. Seven real task runs cost estimated $0.0075136679; the first
  author emitted null optional arrays and was retried. The independent solver
  produced the complete method, but solve-check passed only its final number to
  the semantic comparator. Both owner-contract defects were reproduced and fixed:
  normalize only author-owned optional arrays, and forward the already-produced
  worked solution. The acceptance count now includes failed generation attempts.
- The remaining copy-safety unknown/needs-review decision is retained, not
  overridden. YUK-968 owns closed-book source/verification semantics and a real
  positive generated-card run. Full generated-content acceptance is incomplete;
  the original failure is sealed in evidence/2026-09-07-question-snapshot-actual.json.
- After those deterministic fixes, 182 scoped unit tests, typecheck and build
  passed; 7 current Copilot browser cases and 28 author/snapshot DB tests also passed.
  The method-forwarding regression asserts outside the external adapter so the
  judge's catch cannot swallow an assertion; old code was confirmed RED.
- No production changes. The $10 pool has cumulative estimate $0.0474233747,
  conservative reserve $6.85823 / safe remainder $3.14177. No paid process is
  running; estimates are not account invoices. No third review was started.

## Scope exclusions

No new scheduler, MCP tool, evaluator, provider, viewer fetch endpoint or business
mutation. No deployment, production clone, SoT flag change, backfill or history
deletion. Operational SoT/drain acceptance remains in YUK-887/YUK-951 and is not
silently claimed by local tests.
