import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const [i] = await db.execute<any>(sql`select
  count(*) filter (where status='running')::int as active_ai,
  (select count(*)::int from paid_effect where state in ('pending','sending')) as in_flight,
  (select count(*)::int from paid_effect where state='unknown') as unknowns,
  (select count(*)::int from paid_effect where state='receipt_ready') as receipt_ready
  from ai_task_runs`);
console.log(JSON.stringify(i));
await db.$client.end();
