import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const [t] = await db.execute<any>(sql`select count(*)::int as n, coalesce(sum(cost_usd),0)::float as total,
  count(*) filter (where status='failure')::int as failures from ai_task_runs`);
console.log(JSON.stringify(t));
const per = await db.execute<any>(sql`select task_kind, count(*)::int as n, sum(cost_usd)::float as c from ai_task_runs group by task_kind`);
for (const r of per) console.log(JSON.stringify(r));
await db.$client.end();
