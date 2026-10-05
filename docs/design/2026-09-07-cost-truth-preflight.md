# YUK-976 — Cost truth UI pre-flight

Status: owner approved on 2026-09-07; implementation is limited to the six files below.

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

## Implementation evidence (before review)

Both consumers now use generated `ApiOperationJsonResponse` types and one shared
`describeCosts` formatter. Unknown-only reads as unknown; partial amounts carry
`+ 未知`, with reported/estimated/legacy components and unknown counts shown separately.
Admin loading/error hides monetary KPIs. Empty records and genuine zero stay distinct.
No backend cost logic, provider rates or historical ledger was changed.

15 scoped helper/Today unit tests pass; all 10 new shipped-browser scenarios pass,
covering both pages, desktop/mobile, unknown/mixed/zero/empty and loading/error.
Existing 18 cost API/reader DB tests also passed during the preceding inspection.
Initial browser tests revealed query retries outlasting a 7s assertion and admin mobile
intrinsic-width overflow. Tests now wait for the actual error state and reload at the
mobile viewport; the page-local header width constraint is fixed without global CSS
changes. Two mobile screenshots were inspected, with 390px document width and no
clipped monetary content. Build/typecheck/lint and architecture gates precede PR review.
No paid requests; isolated built API uses the retained clone and no provider credentials.
Review, exact-head CI and local production delivery are recorded below.

## Delivery

PR1360 exact `c6bbf5e18d121e9da0f694baffc5a0cafe528ea3` passed all jobs in
CI Gate `34132735074` and merged as `722b352b09a1e628ae003a36eadf14a2fee18dac`
at 2026-09-07T14:35:12Z. Independent initial review found no P0/P1 and independently
passed 5 helper tests and all 10 browser cases against the exact clean Docker image.
One advisory P2 is deferred, not fixed: known-zero reported/estimated provenance can
be omitted alongside unknown attempts. It is deduplicated and tracked as YUK-977;
unknown amounts remain unknown, and no ledger calculation is affected.

Mac-local **app only** deployed image `c6bbf5e1` at 14:35:29Z. It is healthy with zero
restarts. Worker image `14ea1a81`, worker and Postgres IDs/start times and original
pgdata are unchanged. No migration, NAS/Tunnel change or paid model call occurred.
Live health/auth checks return 200/401/200; both cost APIs return 200. Actual admin
history has 7 day rows and visibly retains source/unknown notes; Today is genuinely
empty. Both real pages were checked at 390px with no overflow or page errors, and the
production mobile screenshot was inspected. Event/task/attempt counts remain
423/258/4 and active/created/retry queue counts remain zero.

The private `runtime-976-app.override.yml` selects only app; removing this overlay
returns app to the retained 975 image without changing worker or Postgres. The isolated
test container was stopped and removed without deleting data volumes. No claim of a
fresh full backup restore or real-provider quality acceptance is made for this UI slice.
