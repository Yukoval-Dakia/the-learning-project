import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const rows = await db.execute(sql`select last_application_error from paid_effect where entity_id = 'yuk1854r2515c-08' and family = 'question_admission_run'`);
console.log((rows as any[])[0].last_application_error);
const q = await db.execute(sql`select id, kind, draft_status, version from question where id = 'yuk1854r2515c-08'`);
for (const r of q as any[]) console.log(JSON.stringify(r));
const cons = await db.execute(sql`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'question'::regclass and contype = 'c'`);
for (const r of cons as any[]) console.log(r.conname, '=>', r.pg_get_constraintdef);
await db.$client.end();
