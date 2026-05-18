# db

Drizzle schema for the current Postgres runtime.

## Runtime driver

| Environment | Driver | Persistence |
| --- | --- | --- |
| Local dev | `postgres` + `drizzle-orm/postgres-js` | `DATABASE_URL` from `.env.local` |
| Tests | `postgres` + `drizzle-orm/postgres-js` | `@testcontainers/postgresql` |
| NAS / Docker compose | `postgres` + `drizzle-orm/postgres-js` | compose `postgres` service volume |

## Migrations

```bash
pnpm db:generate   # schema diff -> ./drizzle/*.sql
pnpm db:migrate    # apply committed migrations
pnpm db:push       # push schema during local/dev setup
```

Migration files are committed to git and applied in order. Tests run against a real Postgres container and apply migrations during global setup.

## JSON fields

Use Postgres `jsonb` for structured payloads and guard shapes at API/write boundaries with Zod. Do not duplicate derived lifecycle fields back into source tables; build readers or projections when the UI needs summaries.
