---
name: postman-api
description: How to regenerate and run this repo's Postman API collection (postman/) for manual exploration of the Hono API surface. Use when adding/changing a route (method, path, request body, query params), when postman/api-endpoints.json needs regenerating, or when running pnpm api:smoke.
---

# Postman / API exploration

`postman/` holds a Postman collection mirroring the Hono API surface（capability manifests → `server/app.ts` mounted routes）plus a secret-free environment. It is the manual-exploration layer; Vitest route tests remain the regression gate. Run headless via `pnpm api:smoke [folder]` (Newman through `pnpm dlx`, token injected from `.env` — no committed dep, no committed secret).

The collection is **generated**, not hand-edited: `postman/api-endpoints.json` is the source of truth. **When you add or change a route（method, path, request body, or query params），edit `postman/api-endpoints.json` and run `pnpm gen:postman`**（idempotent; Biome-formats the output）.

`scripts/gen-postman.ts` has a **manifest 对账层**：每个 spec 条目必须存在于组合根路由清单（capabilities manifests + `/api/health`），死条目 throw——剪 spec 时跑一遍兜底。

See `postman/README.md` for the spec shape.
