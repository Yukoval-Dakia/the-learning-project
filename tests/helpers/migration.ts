// Phase 1c.1 Step 8.C → Step 9.J — HISTORICAL helper. The runMigration entry
// point lives at scripts/migrate-phase1c1.ts; post-Step-9 it throws because
// the legacy tables are gone. This helper is preserved for code that
// historically composed with it; new callers should NOT use it.

import type { Db, Tx } from '@/db/client';
import { runMigration as runMigrationImpl } from '../../scripts/migrate-phase1c1';

export type MigrationResult = { ok: true } | { ok: false; error: string };

export async function runMigrationInTest(db: Db | Tx): Promise<MigrationResult> {
  try {
    await runMigrationImpl(db);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
