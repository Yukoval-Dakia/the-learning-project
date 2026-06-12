// YUK-65 — Drizzle migration runner for docker compose init container.
//
// Bundled to dist/migrate.cjs via `pnpm build:migrate` (esbuild)
// alongside server.js + worker.cjs. The `migrate` compose service runs this
// once at startup; app + worker services wait on
// `depends_on: { migrate: { condition: service_completed_successfully } }`
// so they only start after the schema is current.
//
// Idempotent: drizzle tracks applied migrations in `__drizzle_migrations`
// table — re-runs are no-ops.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL not set');
  process.exit(1);
}

async function main(): Promise<void> {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);
  try {
    console.log('[migrate] applying drizzle migrations from ./drizzle ...');
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('[migrate] done');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
