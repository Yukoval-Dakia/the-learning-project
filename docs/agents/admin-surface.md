# AI Observability Admin Surface

YUK-41 introduced the read-only AI runtime views. The current surface has since grown to cover
subject controls and diagnostics. Page inventory is declared in
`src/kernel/ui-surfaces.ts`; API contracts are declared by the observability capability in
`src/capabilities/observability/manifest.ts`.

Stack anchor: `CLAUDE.md` → **Stack note** (YUK-321 M5 Hono API + Vite SPA).
Current architecture last verified: 2026-07-19 at `5e675969`.

## Routes

| Page | Primary API | Purpose |
| --- | --- | --- |
| `/admin/runs` | `/api/admin/runs`, `/api/admin/runs/[id]` | Recent AI task runs, status, cost, tool-call counts, pg-boss job ids, and a single-run timeline. |
| `/admin/cost` | `/api/admin/cost?days=30` | Cost ledger trend by day and task kind. |
| `/admin/failures` | `/api/admin/failures` | Failed-run clusters grouped by `finish_reason` and error-message prefix. |
| `/admin/subjects` | `/api/admin/subjects` | Subject registry and the entry point to subject controls. |
| `/admin/subjects/$id` | `/api/admin/subjects/[id]`, `/api/admin/subjects/[id]/traits` | Subject detail, validation, lifecycle controls, and trait management. |
| `/admin/coverage-lattice` | `/api/admin/coverage-lattice` | Evidence and assessment coverage diagnostics. |
| `/admin/conjecture-scores` | `/api/admin/conjecture-scores` | Read-only conjecture score diagnostics. |

This table inventories browser-facing admin pages and their primary APIs, rather than every route
owned by the observability capability. The same manifest also owns `/api/cost/today`, which feeds
the workbench cost indicator and does not have a separate admin page.

The manifest uses bracketed parameter segments such as `[id]`. At composition time,
`server/app.ts::toHonoPath` converts them to Hono parameters such as `:id`. TanStack Router uses
`$id` for the corresponding SPA page segment.

## Auth Boundary

- Page routes are Vite SPA surfaces registered from `src/kernel/ui-surfaces.ts` and assembled by
  `web/src/router.tsx`.
- `web/src/main.tsx` wraps the entire router in `web/src/TokenGate.tsx`; authentication is not an
  admin-only layout concern.
- API contracts and lazy handlers live in `src/capabilities/observability/manifest.ts` and are
  mounted by `server/app.ts::buildHonoApp`.
- `server/app.ts` applies a fail-closed `x-internal-token` check to every `/api/*` request. Missing
  configuration and missing or mismatched headers return `401`.
- `/api/health` is the only explicit API authentication bypass. `/api/auth/check` is registered
  after the authentication middleware and is the lightweight endpoint used by `TokenGate`.

## Route Naming

Admin page dependencies use explicit `/api/admin/*` contracts. Route identity comes from the
capability manifest and the Hono composition root; directory-name conventions do not decide
whether an endpoint is routable.

The observability capability also declares authenticated `/api/_/export` and `/api/_/import`
operations. Their underscore is an intentional URL namespace rather than a framework-private
folder convention, and they pass through the same `/api/*` authentication middleware.

## Browser Verification

Historical YUK-41 screenshot:

![YUK-41 admin runs screenshot](./admin-runs-yuk41.png)

Verification notes from the original local browser run:

- Started `pnpm dev:local` against an isolated verification database `loom_yuk41_admin_verify`.
- Applied project migrations from zero to the isolated database.
- Used a temporary local `INTERNAL_TOKEN=dev-token` and seeded sample observability rows only in
  the isolated database.
- Verified a missing token shows `TokenGate` instead of application content.
- Verified `/admin/runs`, `/admin/cost`, and `/admin/failures` render data through
  `/api/admin/*`.
- Verified mobile width `390px`: no page-level horizontal overflow on runs, cost, or failures.
