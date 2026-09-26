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
import { seedKnowledge } from '@/capabilities/knowledge/server/seed';
import * as schema from '@/db/schema';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';

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

    // YUK-951: refuse to strand an unverified installation's old mailbox work.
    // Resolve only after the explicit DATABASE_URL is bound; this guard is read-only.
    const { assertCopilotLegacyDrained } = await import(
      '../src/capabilities/copilot/server/legacy-drain-readiness'
    );
    await assertCopilotLegacyDrained(db);
    console.log('[migrate] Copilot legacy drain readiness: clear');

    // 冷启薄 seed（YUK-477）：每个已知科目一个 domain-root 节点。幂等（ON CONFLICT DO NOTHING +
    // 稳定 id，重跑/并发均安全），所以 init container 每次启动安全调用——让 fresh DB 树非空，给上传
    // 子 KC 挂靠锚。**seed 失败有意 fatal**（在 migrate 的 try 内，throw → main().catch 的
    // process.exit(1)）：空树正是 YUK-477 要防的失效（上传无锚 / goal·placement 落空），所以 seed
    // 是 day-one 硬前置而非可降级——不要把它包成吞错的 best-effort（会让 fresh DB 静默落空树）。
    const seeded = await seedKnowledge(db);
    console.log(
      `[migrate] subject-root seed: +${seeded.inserted} inserted, ${seeded.skipped} existing`,
    );

    // YUK-599（v3 §6）：subject 控制面种子/升级单写者 = migrate init container
    // （app/worker boot 只 read-hydrate）。幂等由「seed_version 相等整行硬跳过」
    // 成立——重跑零副作用。失败同 seedKnowledge 纪律 fatal：四 builtin 行/绑定
    // 缺席会让 thin-create/goal 防线（YUK-600）踩空，宁可 init container 红。
    const traits = await reconcileBuiltinTraits(db);
    console.log(
      `[migrate] builtin trait reconcile: +${traits.insertedSubjects} subjects, ` +
        `+${traits.insertedTraits} traits, ${traits.upgradedTraits} upgraded, ` +
        `${traits.skippedTraits} up-to-date, ${traits.preservedTraits} owner-edited preserved`,
    );

    // YUK-973: prepare legacy data before the canonical writers start. Failure is fatal;
    // never conceal incomplete history with a fresh snapshot or rebuild live learner rows.
    // The legacy CLI module loads .env: defer it until the explicit URL above has
    // been required and bound to this connection, preserving the migration target gate.
    const { migrateCanonicalProjections } = await import('./migrate-canonical-projections');
    const projections = await migrateCanonicalProjections(db);
    console.log('[migrate] canonical projection readiness:', JSON.stringify(projections));

    // YUK-1055 — DB contract epoch observability（启动准备宽于 SQL）：0109 已在
    // SQL 侧 seed 隐式 ('legacy','active') marker；这里读回并日志化，让 migrate
    // init container 的输出本身成为 epoch 就绪证据。读不出 = 未迁移到位 → fatal
    //（init container 红，app/worker 不会在没有 marker 语义的库上跑）。
    const { readContractEpoch, CODE_CONTRACT_EPOCH } = await import('@/server/contract-epoch');
    const epochMarker = await readContractEpoch(db);
    if (!epochMarker) {
      throw new Error(
        '[migrate] contract_epoch marker absent after migrations — epoch guard has no semantics',
      );
    }
    console.log(
      `[migrate] contract epoch: ${epochMarker.epoch}/${epochMarker.state} ` +
        `(seq ${epochMarker.seq}; code epoch ${CODE_CONTRACT_EPOCH})`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
