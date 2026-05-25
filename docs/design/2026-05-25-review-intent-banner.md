# ReviewIntent Banner Dismiss/Refresh Design

## Scope

YUK-62 tightens the `/review` session intent banner. The intent remains a best-effort one-line hint from `ReviewIntentTask`; this lane only defines how the user can hide or refresh that hint.

## Decisions

- Dismiss trigger: explicit icon button in the banner. No double-click or hover-only behavior.
- Dismiss persistence: `localStorage`, scoped to the current local date and exact intent text. This keeps a user preference out of the append-only event log.
- Intent generation: each review page load still asks `/api/review/plan`; no cross-session server reuse is introduced.
- Refresh: explicit icon button calls the existing `review-intent` query refetch and clears any local dismiss state for the current intent.
- Stale hint: if the query data backing the banner is older than 24 hours, the banner shows a compact stale marker. Normal query behavior still uses the existing five-minute stale time.

## Boundaries

- No schema change.
- No new event action for dismiss.
- No change to `ReviewIntentTask` prompt or `/api/review/plan` response shape.
