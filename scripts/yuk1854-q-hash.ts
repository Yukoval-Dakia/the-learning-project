import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const idx = await db.execute(sql`select indexname, indexdef from pg_indexes where tablename='question' and indexdef like '%canonical_content_hash%'`);
for (const r of idx as any[]) console.log(r.indexname, '=>', r.indexdef);
const qs = await db.execute(sql`select id, left(canonical_content_hash,16) as h, draft_status from question where id like 'yuk1854r2515%' order by id`);
for (const r of qs as any[]) console.log(JSON.stringify(r));
await db.$client.end();
