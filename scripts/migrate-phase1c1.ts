// HISTORICAL: legacy tables (mistake / review_event / dreaming_proposal /
// ingestion_session) were DROP'd in Phase 1c.1 Step 9.J. This script is no
// longer runnable against the current schema — it stays in repo as historical
// record of the legacy → event-driven mapping logic. The migration ran once
// against prod data during the Phase 1c.1 maintenance window.
//
// The source-of-truth implementation lived at this path before Step 9; see
// git history (commit before 0006_drop_legacy_tables.sql migration) for the
// full bridgeCause / migrateMistakeRows / migrateReviewEventRows /
// migrateDreamingProposalRows / migrateIngestionSessionRows logic. Step 9.K
// removed the test files (scripts/migrate-phase1c1.test.ts +
// tests/integration/migrate-phase1c1.integration.test.ts) since they
// depended on the dropped tables.
//
// Phase 1c.1 Step 3 — legacy → event-driven migration (no longer runnable).

import type { Db, Tx } from '@/db/client';

type DbLike = Db | Tx;

export interface MigrationStats {
  attempt: number;
  judge: number;
  review: number;
  propose: number;
  ingestion_session: number;
  material_fsrs_state: number;
}

/**
 * Historical entry point. Always throws — the legacy tables it reads are
 * gone. Kept as a documented stub so historic references typecheck.
 */
export async function runMigration(_db: DbLike): Promise<MigrationStats> {
  throw new Error(
    'runMigration is HISTORICAL — legacy tables (mistake / review_event / dreaming_proposal / ingestion_session) were DROPped in Phase 1c.1 Step 9.J. See git history before the 0006_drop_legacy_tables.sql migration for the original implementation.',
  );
}
