import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const a = await db.execute(sql`select id, task_kind, status, started_at from ai_task_runs where status='running' order by started_at desc limit 10`);
for (const r of a as any[]) console.log('running:', JSON.stringify(r));
const u = await db.execute(sql`select entity_id, family, state from paid_effect where state in ('unknown','pending','sending') order by created_at`);
for (const r of u as any[]) console.log('paid:', JSON.stringify(r));
await db.$client.end();
