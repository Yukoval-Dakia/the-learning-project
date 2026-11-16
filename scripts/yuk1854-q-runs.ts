import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const rows = await db.execute(sql`select id, task_kind, status, finish_reason, cost_usd,
  left(error_message,150) as err, started_at, finished_at
  from ai_task_runs where started_at > '2026-11-05 16:55' order by started_at`);
for (const r of rows as any[]) console.log(JSON.stringify(r));
const paid = await db.execute(sql`select entity_id, family, state, created_at, updated_at from paid_effect where entity_id like 'yuk1854r2515c-%' order by created_at`);
for (const r of paid as any[]) console.log(JSON.stringify(r));
await db.$client.end();
