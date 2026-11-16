import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const rows = await db.execute(sql`select entity_id, family, state, fence, created_at, updated_at from paid_effect where state = 'unknown' order by created_at`);
for (const r of rows as any[]) console.log(JSON.stringify(r));
console.log('--- runs failing ---');
const fails = await db.execute(sql`select id, task_kind, status, finish_reason, error_message, started_at, finished_at, cost_usd from ai_task_runs where status='failure' order by started_at`);
for (const r of fails as any[]) console.log(JSON.stringify(r));
await db.$client.end();
