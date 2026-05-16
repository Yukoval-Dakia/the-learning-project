// Phase 1c.1 Step 8.C — thin re-export of `runMigration` for cross-suite use.
//
// The full integration test for `runMigration` lives in
// `tests/integration/migrate-phase1c1.integration.test.ts` (50-row realistic
// fixture). This helper exists so other test files can compose with the
// migration when they want to exercise the full Step-3 → Step-5 chain
// end-to-end without duplicating the import path or wrapping logic.
//
// Kept deliberately minimal: re-export the function and its declared result
// shape. Any future test-side guards (e.g., timing, retry semantics) layer
// in here, not in the script.

import type { Db, Tx } from '@/db/client';
import { runMigration as runMigrationImpl } from '../../scripts/migrate-phase1c1';

export type MigrationResult = { ok: true } | { ok: false; error: string };

export function runMigrationInTest(db: Db | Tx): Promise<MigrationResult> {
  return runMigrationImpl(db);
}
