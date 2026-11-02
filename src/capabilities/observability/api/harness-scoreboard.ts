import { HARNESS_SCOREBOARD_VERSION } from '@/core/schema/harness-scoreboard';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readLatestHarnessScoreboard } from '../server/harness-scoreboard';

export async function GET(): Promise<Response> {
  try {
    const latest = await readLatestHarnessScoreboard(db);
    const current = latest?.status === 'current' ? latest : null;
    return Response.json({
      scoreboard: current?.scoreboard ?? null,
      age_hours: latest?.age_hours ?? null,
      stale: current === null || current.age_hours > 36,
      note:
        latest === null
          ? 'no harness scoreboard projection yet; run harness_scoreboard_daily or the CLI'
          : latest.status === 'version_mismatch'
            ? `latest harness scoreboard projection is version ${latest.latest_version ?? 'unknown'}; no readable version ${HARNESS_SCOREBOARD_VERSION} projection; run harness_scoreboard_daily or the CLI`
            : 'daily deterministic projection; m3/m4/m5 list the ADR sub-items in parts[], each with its own numerator/denominator and basis',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
