import { db } from '@/db/client';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

const DB_PROBE_TIMEOUT_MS = 5_000;

export async function GET() {
  let db_ok = false;

  try {
    const probe = db.execute(sql`select 1 as ok`);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`db probe timed out after ${DB_PROBE_TIMEOUT_MS}ms`)),
        DB_PROBE_TIMEOUT_MS,
      );
    });
    const result = (await Promise.race([probe, timeout])) as unknown as Array<{ ok: number }>;
    db_ok = result[0]?.ok === 1;
  } catch (err) {
    // /api/health is unauthenticated — log the DB exception code/message
    // server-side only, never include it in the public payload.
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error ? err.name : 'unknown';
    console.error('health: db check failed', {
      code,
      message,
      timestamp: new Date().toISOString(),
    });
    db_ok = false;
  }

  // Return 503 when the DB probe fails so uptime monitors / Vercel health checks
  // can distinguish "service alive + DB down" from "all green". The function
  // itself succeeded either way — that's `ok: true`.
  return Response.json(
    {
      ok: true,
      db_ok,
    },
    { status: db_ok ? 200 : 503 },
  );
}
