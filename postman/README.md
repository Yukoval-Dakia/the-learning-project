# Postman — API exploration + smoke

Collection-as-code for the Hono API surface（capability manifests → `server/app.ts` mounted routes）. Postman is the **exploration / manual-verification** layer; Vitest route tests stay the regression gate. What you confirm here, codify back into a route test.

> YUK-321 M5（2026-06-13）起，后端真相源 = capability manifests（`src/capabilities/*/manifest.ts`）+ 组合根 `server/app.ts`；不再有 `app/api/**` Next route handler 壳文件。本 README 早期版本提及 `app/api/**` 的描述已过时。

## Files

| File | What |
|---|---|
| `api-endpoints.json` | **Source of truth.** Hand-maintained per-route specs (path, methods, query, body, notes). Edit this when a route changes. |
| `learning-api.postman_collection.json` | **Generated** from `api-endpoints.json` by `pnpm gen:postman` — do not hand-edit. One folder per top-level segment; collection-level API-key auth injects `x-internal-token: {{internalToken}}`; `/api/health` overrides to no-auth. |
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
API_SMOKE_BASE_URL=http://localhost:8787 pnpm api:smoke   # override target (Hono port)
```

`scripts/api-smoke.ts` loads `INTERNAL_TOKEN` from `.env` and injects it (plus
`baseUrl`) into Newman as env-vars, so the committed environment file stays
secret-free. Newman runs via `pnpm dlx newman@6` — **not** a project dependency,
zero install footprint (first run fetches it into the pnpm store).

## Gotchas (project-specific)

- **Port:** default `baseUrl` is `http://localhost:8787` —— the Hono API port
  (post YUK-321 M5). OrbStack 容器内 app 亦 listen :8787；旧 dev :3001/:3000 端口
  已不再使用（Vite SPA 走 :5173 + `/api` proxy → :8787）。
- **Token:** `INTERNAL_TOKEN` lives in `.env`. Without it, only `/api/health`
  works（`server/app.ts` 组合根层 token 校验豁免 `/api/health`）；everything else 401s.
- **Placeholder values:** path vars are `REPLACE_*` and bodies use example IDs.
  Replace them with real IDs before sending. The only guaranteed-safe target
  with placeholders is the `health` folder.
- **Mutating endpoints:** most non-GET requests write/delete data. `--no-folder`
  runs them all — don't point it at anything you care about. `_/import` wipes the
  DB; `_/export` and `assets`/`ingestion` uploads are multipart/binary.
- **SSE endpoints** (`/api/copilot/chat`, `*/events`,
  `/api/knowledge/review`) stream `text/event-stream`; Postman/Newman show the
  chunked body but won't render incrementally in CI mode.

## Regenerating

The collection is **generated**, never hand-edited. To add or change an endpoint:

1. Edit `postman/api-endpoints.json` (the source). One entry per route:
   ```jsonc
   { "path": "/api/knowledge/:id",
     "methods": [
       { "method": "GET", "summary": "...", "query": [{ "name": "limit", "required": false, "example": "20" }],
         "contentType": "application/json", "bodyExample": { ... }, "formFields": null, "notes": "..." }
     ] }
   ```
   `:param` marks a path variable. `contentType: "multipart/form-data"` (or any
   `formFields`) produces a form-data body; `bodyExample` produces a raw JSON body.
2. Run `pnpm gen:postman`. It rewrites the collection and Biome-formats it —
   running it twice is a no-op (idempotent).

`scripts/gen-postman.ts` is the generator. **M5-T5c（YUK-321）起新增 manifest 对账层**：每个 `api-endpoints.json` 条目必须存在于组合根路由清单（capabilities manifests 声明的 `api.routes` + 组合根直挂的 `GET /api/health`），死条目（manifest 没有声明的路由）触发 throw，gen-postman 失败——这防止旧 app/ 独有路由残留进 collection。manifest 有而 spec 缺的路由只打 WARN（内部调试端点允许不进 collection）。路径归一化层把 manifest 的 `[id]` 风格参数与 spec 的 `:id` 风格参数对齐再比照。

The `api-endpoints.json` specs were originally extracted by reading every Next `app/api/**/route.ts`（method, Zod body schema, query params）；YUK-321 M5 起 `app/` 已删，spec 维护改为对照 `src/capabilities/*/manifest.ts` 的 `api.routes` 数组——CLAUDE.md convention 提醒新增/改 route 时同步 spec 并跑 `pnpm gen:postman`，manifest 对账层兜底。
