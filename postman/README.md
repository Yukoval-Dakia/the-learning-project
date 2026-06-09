# Postman — API exploration + smoke

Collection-as-code for the `app/api/**` surface. Postman is the **exploration /
manual-verification** layer; Vitest route tests stay the regression gate. What
you confirm here, codify back into a route test.

## Files

| File | What |
|---|---|
| `learning-api.postman_collection.json` | All `app/api/**` endpoints, one folder per top-level segment. Collection-level API-key auth injects `x-internal-token: {{internalToken}}`; `/api/health` overrides to no-auth. Generated — see *Regenerating*. |
| `learning-local.postman_environment.json` | `baseUrl` + `internalToken` (ships **empty** — the secret is never committed). |

## Using it

**GUI:** import both files. Pick the `learning-local` environment, set
`internalToken` to the value of `INTERNAL_TOKEN` from `.env` (note: `.env`, not
`.env.local`). Point `baseUrl` at a running dev server.

**Headless (and how the agent drives it):**

```bash
pnpm api:smoke                 # default: only the `health` folder — server-up probe, safe
pnpm api:smoke knowledge       # run one route folder by name
pnpm api:smoke --no-folder     # whole collection (mutating endpoints included — see caveats)
API_SMOKE_BASE_URL=http://localhost:3000 pnpm api:smoke   # override target
```

`scripts/api-smoke.ts` loads `INTERNAL_TOKEN` from `.env` and injects it (plus
`baseUrl`) into Newman as env-vars, so the committed environment file stays
secret-free. Newman runs via `pnpm dlx newman@6` — **not** a project dependency,
zero install footprint (first run fetches it into the pnpm store).

## Gotchas (project-specific)

- **Port:** default `baseUrl` is `http://localhost:3001` — the fresh
  `pnpm dev:local` port. OrbStack's container squats on `:3000` and serves a
  stale build. Hitting `:3000` tests old code.
- **Token:** `INTERNAL_TOKEN` lives in `.env`. Without it, only `/api/health`
  works (middleware-exempt); everything else 401s.
- **Placeholder values:** path vars are `REPLACE_*` and bodies use example IDs.
  Replace them with real IDs before sending. The only guaranteed-safe target
  with placeholders is the `health` folder.
- **Mutating endpoints:** most non-GET requests write/delete data. `--no-folder`
  runs them all — don't point it at anything you care about. `_/import` wipes the
  DB; `_/export` and `assets`/`ingestion` uploads are multipart/binary.
- **SSE endpoints** (`/api/ai/:task`, `/api/copilot/chat`, `*/events`,
  `/api/knowledge/review`) stream `text/event-stream`; Postman/Newman show the
  chunked body but won't render incrementally in CI mode.

## Regenerating

The collection is generated from per-route specs, not hand-edited. When routes
change, re-extract and regenerate rather than editing the JSON by hand. The
throwaway generator (`/tmp/gen-collection.mjs`) reads endpoint-spec JSON files
from `/tmp/api-groups/*.json` (shape: `[{path, methods:[{method, summary, query,
contentType, bodyExample, formFields, notes}]}]`) and writes the collection. To
add or fix one endpoint by hand, edit the JSON directly and keep it valid
(`node -e "require('./postman/learning-api.postman_collection.json')"`).
