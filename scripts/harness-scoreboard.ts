// YUK-1557 — deterministic harness scoreboard CLI.
//
// Read-only by default: it prints the exact M1–M6 payload for a BJT day range
// so the 10-07..10-18 review numbers can be recomputed. `--persist` writes the
// same projection event the daily job writes (idempotent per day range).
//
//   pnpm harness:scoreboard --from 2026-10-07 --to 2026-10-18
//   pnpm harness:scoreboard --from 2026-10-07 --to 2026-10-18 --persist

import './load-env';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeHarnessScoreboard,
  writeHarnessScoreboard,
} from '@/capabilities/observability/server/harness-scoreboard';
import { db } from '@/db/client';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  try {
    const fromDay = flag('from');
    const toDay = flag('to');
    if (!fromDay || !toDay) {
      console.error('usage: pnpm harness:scoreboard --from YYYY-MM-DD --to YYYY-MM-DD [--persist]');
      process.exitCode = 2;
      return;
    }
    const scoreboard = await computeHarnessScoreboard(db, { fromDay, toDay });
    if (process.argv.includes('--persist')) await writeHarnessScoreboard(db, scoreboard);
    console.log(JSON.stringify(scoreboard, null, 2));
  } catch (err) {
    console.error(
      `[harness-scoreboard] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    try {
      await db.$client.end({ timeout: 5 });
    } catch {
      // best-effort pool shutdown
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
