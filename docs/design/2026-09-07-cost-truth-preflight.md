# YUK-976 — Cost truth UI pre-flight

Status: awaiting owner UI approval. No UI code changed.

## Existing design and surfaces

Existing prototype `docs/design/loom-prototype/screen-today.jsx:164-166`:

```jsx
      <Stateful state={state} onRetry={onRetry} errorText="成本服务暂不可用。"
        skeleton={<SkLines rows={1} />}
        empty={<div className="quiet-empty">今日尚无 AI 花费。</div>}>
```

The existing CostRibbon layout is also recorded in
`docs/design/2026-06-04-redraw-today-7b-preflight.md:27`.
Type: existing route/page components (`/today` cost card and `/admin/cost`).
No new drawer, route, modal, budget control or Copilot ribbon.

## Evidence and intended correction

At main `5e6562917`, backend cost aggregation already exposes reported/estimated/legacy
amounts, unknown counts and currency. 18 scoped API/reader DB tests pass. The live
`/api/cost/today` response is genuinely empty today; that is not an unknown-cost canary.

Browser test on the shipped local image `14ea1a81`, intercepting only the read response
for `/api/admin/cost`, used a valid unknown USD row (8,912 input / 731 output tokens,
one call, known cost 0, unknown_attempts 1). Actual result: `$0.0000` visible, no unknown
label. No database mutation or model call. The Today consumer loses the same fields.

Proposed behavior: retain current layout/tokens/primitives, show known subtotal as such,
distinguish reported/estimated/legacy and explicitly show unknown attempts. Unknown-only
must not read as free; loading/error must not show a fabricated zero. Preserve real
zero and small nonzero values, currencies, refresh, task/day summaries and empty state.
Reuse `ApiOperationJsonResponse` from existing generated API contracts, replacing the
two hand-written narrowed response types. No API/schema/pricebook/ledger change.

## Exact intended implementation files

- Modify `src/capabilities/shell/ui/TodayPage.tsx`.
- Modify `src/capabilities/observability/ui/admin-cost.tsx`.
- Add `src/ui/lib/cost-presentation.ts` (shared pure presentation over existing contract types).
- Add `src/ui/lib/cost-presentation.unit.test.ts`.
- Modify `tests/usability/api-fixtures.ts`.
- Modify `tests/usability/shipped-container.spec.ts`.

The tests cover unknown-only, mixed reported/estimated/legacy plus unknown, genuine zero,
small known amounts, USD/CNY separation, loading/error and both shipped page consumers.
After approval: scoped tests, typecheck/lint/build, built-browser verification,
independent review and exact-head CI, then previously authorized Mac-local deployment.
NAS and extra model spending remain out of scope.
