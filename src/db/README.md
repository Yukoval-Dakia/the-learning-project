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

`drizzle/meta/*_snapshot.json` is the input baseline for the next `db:generate`; the SQL journal
alone does not teach drizzle-kit about schema changes. Migration `0070_yuk736_snapshot_baseline`
repairs the former 0063 snapshot gap by recording the current schema with a no-op SQL migration.

For a schema-changing hand-written migration, first run `db:generate`, then edit the generated
SQL as needed **without deleting its snapshot or journal entry**. Use `--custom` only for SQL that
does not change the Drizzle-managed schema, because a custom migration copies the previous
snapshot instead of capturing `src/db/schema.ts`. Always inspect the generated SQL and run
`pnpm test:migration` before committing.

## JSON fields

Use Postgres `jsonb` for structured payloads and guard shapes at API/write boundaries with Zod. Do not duplicate derived lifecycle fields back into source tables; build readers or projections when the UI needs summaries.
