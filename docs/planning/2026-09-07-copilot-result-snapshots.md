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
  and raw FSRS fields receive explicit narrowing; generated output publishes
  text only; write/proposal results publish stable receipts, not HTML/diagnostics.
- Public JSON is capped at 32,000 UTF-8 bytes. Natural result lists may omit
  complete trailing entries with a separate count; original coverage and totals
  remain intact. Atomic content is never clipped into a misleading fragment.
  Missing history, unavailable results, real empty arrays, false, zero and null
  remain distinct. Optional JS undefined follows the existing JSON wire behavior.
- Generated text joins the existing learning-validation surface. Ordinary reads
  do not add model calls. Snapshots never enter model conversation history.
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
- Independent review and exact-head CI are still required; not yet merged.
- No new paid calls, no production changes. The $10 pool remains conservative
  reserve $5.55823 / safe remainder $4.44177; estimates are not account invoices.

## Scope exclusions

No new scheduler, MCP tool, evaluator, provider, viewer fetch endpoint or business
mutation. No deployment, production clone, SoT flag change, backfill or history
deletion. Operational SoT/drain acceptance remains in YUK-887/YUK-951 and is not
silently claimed by local tests.
