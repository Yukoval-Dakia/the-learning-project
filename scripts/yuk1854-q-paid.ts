import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const cols = await db.execute(sql`select column_name from information_schema.columns where table_name='paid_effect' order by ordinal_position`);
console.log('cols:', (cols as any[]).map(c=>c.column_name).join(','));
const like = process.env.Q_LIKE ?? 'yuk1854r2515b-%';
const rows = await db.execute(sql`select * from paid_effect where entity_id like ${like} order by created_at`);
for (const r of rows as any[]) {
  const s = { ...r };
  for (const k of Object.keys(s)) if (typeof s[k] === 'string' && s[k].length > 200) s[k] = s[k].slice(0,200)+'…';
  console.log(JSON.stringify(s));
}
await db.$client.end();
