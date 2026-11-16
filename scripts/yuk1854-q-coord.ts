import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const e = process.env.Q_ENTITY ?? 'yuk1854r2515c-08';
const rows = await db.execute(sql`select family, state, fence,
  result_json->'result'->>'status' as status,
  result_json->'result'->'waiting' as waiting,
  result_json->'result'->>'reason' as reason,
  result_json->'result'->>'decision' as decision,
  left(result_json::text, 600) as r_head
  from paid_effect where entity_id = ${e} order by created_at`);
for (const r of rows as any[]) console.log(JSON.stringify(r));
await db.$client.end();
