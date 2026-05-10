import { db } from '@/db/client';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET() {
  let db_ok = false;
  try {
    const result = await db.execute(sql`select 1 as ok`);
    const rows = result as unknown as Array<{ ok: number }>;
    db_ok = rows[0]?.ok === 1;
  } catch (err) {
    console.error('health: db check failed', err);
    db_ok = false;
  }
  return Response.json({ ok: true, db_ok });
}
