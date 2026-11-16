import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const a = await db.execute(sql`select id, task_kind, status, cost_usd, left(error_message,120) as err, started_at, finished_at
  from ai_task_runs order by started_at desc limit 12`);
for (const r of a as any[]) console.log(JSON.stringify(r));
await db.$client.end();
