import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readLatestHarnessScoreboard } from '../server/harness-scoreboard';

export async function GET(): Promise<Response> {
  try {
    const latest = await readLatestHarnessScoreboard(db);
    return Response.json({
      scoreboard: latest?.scoreboard ?? null,
      age_hours: latest?.age_hours ?? null,
      stale: latest === null || latest.age_hours > 36,
      note:
        latest === null
          ? 'no harness scoreboard projection yet; run harness_scoreboard_daily or the CLI'
          : 'daily deterministic projection; m3/m4 basis fields state where the raw tables only support a proxy',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
