import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const rows = await db.execute(sql`select entity_id, family, state, last_application_error, result_recorded_at, applied_at, send_lease_expires_at, updated_at
  from paid_effect where entity_id = 'yuk1854r2515c-08' and family = 'question_admission_run'`);
for (const r of rows as any[]) console.log(JSON.stringify(r));
await db.$client.end();
