// YUK-471 W1 PR-A2a / YUK-548 (worklist #5) — full projection rebuild: re-fold ids of the given
// kinds from the event log via the registry write-through shells.
//
// WHY. The write-through shells (projectKnowledgeNode / projectGoalGuarded / …) are the SoT-write
// primitive the accept path flips to. This script reuses them 1:1 to do a FULL rebuild: for every id
// of a kind it calls the shell, which re-derives the row from the event log and writes it through
// (upsert) — or DELETEs it if the fold resolves to null (guarded shells only delete an ANCHORED row).
// Reusing the per-id shell keeps the rebuild path BYTE-IDENTICAL to the live SoT path.
//
// YUK-548: generalized from the hard-coded knowledge/knowledge_edge pair to ALL 7 registry kinds.
// The id universe per kind = live ids ∪ event-subject ids ∪ index anchors (allProjectionIds) — a
// dropped-out-of-band row still anchored/event-sourced re-materializes so the survival check sees it.
//
// TX / FK. Kinds are rebuilt PER FK-CLUSTER (PROJECTION_FK_CLUSTERS): the only real inter-projection
// FK is knowledge_edge → knowledge, so that pair shares one tx (knowledge first); every other kind is
// its own tx. A topology/FK reject rolls back only its cluster, not all 7 (Lens B m7).
//
// The owner runs this against a PROD-CLONE for the B3 gate (rebuild, then audit:projection CLEAN),
// not against live prod. BEHAVIOR-PRESERVING: a standalone operational script; NOT wired into any
// request path.
//
// CLI:
//   pnpm rebuild:projection   # re-fold every kind, per FK-cluster tx, in place

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { type Db, type Tx, db } from '@/db/client';
import {
  PROJECTION_ENTITIES,
  PROJECTION_FK_CLUSTERS,
  type ProjectionKind,
  allProjectionIds,
} from '../src/server/projections/entity-registry';

type DbLike = Db | Tx;

// Per-kind count of ids re-projected. Partial — a call rebuilds only the kinds it was asked for
// (m10: this REPLACES the old `{ nodes, edges }` shape; printReport / --json / tests updated in sync).
export type RebuildCounts = Partial<Record<ProjectionKind, number>>;

/**
 * Re-fold every id of each `kind` through its registry write-through shell, IN THE CALLER'S tx (so
 * the B3 gate / CLI can wrap a whole FK-cluster in one tx). Kinds are processed IN ARRAY ORDER so a
 * cluster's FK parent (knowledge) rebuilds before its child (knowledge_edge). Returns the per-kind
 * count. Throws (rolling the caller's tx back) if a projection hits an ADR-0034 topology reject.
 */
export async function rebuildProjectionForKinds(
  db: DbLike,
  kinds: readonly ProjectionKind[],
): Promise<RebuildCounts> {
  const counts: RebuildCounts = {};
  for (const kind of kinds) {
    const adapter = PROJECTION_ENTITIES[kind];
    const ids = await allProjectionIds(db, kind);
    for (const id of ids) {
      await adapter.project(db, id);
    }
    counts[kind] = ids.length;
  }
  return counts;
}

async function main(): Promise<void> {
  // ONE tx per FK-cluster: a topology reject mid-cluster aborts only that cluster, not every kind.
  // Per-cluster isolation (review K2): the clusters are INDEPENDENT (that is the point of the
  // FK-cluster split), so one failing cluster must not abort the remaining ones — its tx rolled back
  // alone; log it, continue, and report the failure set at the end with a non-zero exit. The rebuild
  // is idempotent, so re-running after fixing a failed cluster converges.
  const total: RebuildCounts = {};
  const failed: { cluster: readonly ProjectionKind[]; error: string }[] = [];
  for (const cluster of PROJECTION_FK_CLUSTERS) {
    try {
      const counts = await db.transaction((tx) => rebuildProjectionForKinds(tx, cluster));
      Object.assign(total, counts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ cluster, error: msg });
      console.error(
        `[rebuild-projection] cluster [${cluster.join(', ')}] FAILED — tx rolled back, continuing with the remaining clusters:`,
        msg,
      );
    }
  }
  const summary = Object.entries(total)
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ');
  if (failed.length > 0) {
    console.error(
      `[rebuild-projection] ${failed.length} cluster(s) FAILED (${failed
        .map((f) => `[${f.cluster.join(', ')}]`)
        .join(', ')}); succeeded: ${summary || '(none)'}. Fix and re-run (idempotent).`,
    );
    process.exit(1);
  }
  console.log(`[rebuild-projection] done — re-folded in place (${summary}).`);
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import rebuildProjectionForKinds
// without the top-level run firing.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('rebuild-projection.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[rebuild-projection] failed:', err);
      process.exit(1);
    });
}
