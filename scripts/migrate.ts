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

import { seedKnowledge } from '@/capabilities/knowledge/server/seed';
import * as schema from '@/db/schema';
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
  // schema-bound instance so the post-migrate seed runner (typed `Db`) type-checks
  // and resolves the `knowledge` table; bare drizzle(sql) lacks the schema binding.
  const db = drizzle(sql, { schema });
  try {
    console.log('[migrate] applying drizzle migrations from ./drizzle ...');
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('[migrate] done');

    // 冷启薄 seed（YUK-477）：每个已知科目一个 domain-root 节点。幂等（稳定 id，重跑 skip），
    // 所以 init container 每次启动安全调用——让 fresh DB 树非空，给上传子 KC 挂靠锚。
    const seeded = await seedKnowledge(db);
    console.log(
      `[migrate] subject-root seed: +${seeded.inserted} inserted, ${seeded.skipped} existing`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
