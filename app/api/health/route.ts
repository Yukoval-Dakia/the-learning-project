import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const runtime = 'nodejs';

const DB_PROBE_TIMEOUT_MS = 5_000;

export async function GET() {
  let db_ok = false;
  let db_error: { code: string; message: string } | undefined;

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
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error ? err.name : 'unknown';
    db_error = { code, message };
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
      ...(db_error && { db_error }),
    },
    { status: db_ok ? 200 : 503 },
  );
}
