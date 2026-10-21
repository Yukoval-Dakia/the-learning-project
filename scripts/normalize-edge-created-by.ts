// One-shot data migration: normalize legacy knowledge_edge rows whose created_by / created_at
// diverge from their fold.
//
// Before the create-path fix, createKnowledgeEdge stored created_by as a bare string and stamped
// its own created_at instead of using the paired generate event. The fold reconstructs the actor
// object and takes created_at from the event, so those edges report as projection drift and block
// the SoT flip. This repairs only those two columns, and only for event-sourced edges; a row that
// drifts on another field stays visible to the audit rather than being silently rewritten.
//
// Event-less edges fold to null and are left to the scoped genesis backfill. The genesis skip
// means a legacy bare-string actor can never be seeded over, and the snapshot schema would reject
// it at write time anyway. Idempotent: a row already matching its fold is skipped.
//
// Needs a populated DB; run on a prod-clone (and prod) before flipping PROJECTION_IS_WRITER=1.

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { eq } from 'drizzle-orm';
import { type Db, type Tx, db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { edgeRowToSnapshot, gatherAndFoldKnowledgeEdgeWithMesh } from '@/server/projections/gather';
import { diffSnapshots } from '@/server/projections/snapshot-diff';

type DbLike = Db | Tx;

export interface NormalizeCounts {
  checked: number;
  normalized: number;
}

/**
 * Repair event-sourced edges whose created_by / created_at diverge from fold(events), updating only
 * those two columns. Idempotent. Exported so the DB test can drive it.
 */
export async function normalizeEdgeCreatedBy(db: DbLike): Promise<NormalizeCounts> {
  const rows = await db.select().from(knowledge_edge);
  // Fold against one mesh built from the rows already read, instead of re-selecting the live edge
  // set per edge. Safe because this migration only updates created_by/created_at, never topology.
  const liveMesh = rows.filter((r) => r.archived_at === null).map(edgeRowToSnapshot);
  let normalized = 0;
  for (const row of rows) {
    const folded = await gatherAndFoldKnowledgeEdgeWithMesh(db, row.id, liveMesh);
    // Event-less edge (no generate event) — folds to null. The scoped genesis backfill anchors
    // these; this migration only repairs event-sourced edges.
    if (!folded) continue;
    const diffs = diffSnapshots(
      edgeRowToSnapshot(row) as Record<string, unknown>,
      folded as unknown as Record<string, unknown>,
    );
    // Only act on the two columns the legacy createKnowledgeEdge diverged on. A diff on any OTHER
    // field is a separate drift the audit surfaces — not rewritten here.
    const relevant = diffs.some((d) => d.startsWith('created_by') || d.startsWith('created_at'));
    if (!relevant) continue;
    await db
      .update(knowledge_edge)
      .set({ created_by: folded.created_by as never, created_at: folded.created_at })
      .where(eq(knowledge_edge.id, row.id));
    normalized += 1;
  }
  return { checked: rows.length, normalized };
}

async function main(): Promise<void> {
  const counts = await normalizeEdgeCreatedBy(db);
  console.log(
    `[normalize-edge-created-by] done — checked ${counts.checked} edge(s), normalized ${counts.normalized} legacy row(s) (created_by/created_at aligned to fold).`,
  );
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import the fn without the
// top-level run firing.
if (
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('normalize-edge-created-by.ts')
) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[normalize-edge-created-by] failed:', err);
      process.exit(1);
    });
}
