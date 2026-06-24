// YUK-471 W1 B3 (BYPASS-2 fix) — one-shot data migration: normalize legacy knowledge_edge rows
// whose created_by / created_at diverge from their fold.
//
// WHY. Before the BYPASS-2 fix, createKnowledgeEdge (used by the public POST /api/edges route AND
// the reconcile SUPERSEDE path) stored `created_by` as a BARE STRING ('user' / 'dreaming') and
// stamped its OWN created_at (independent of the paired `generate` event). But the edge FOLD
// reconstructs `created_by` as the object {actor_kind, actor_ref} and takes `created_at` FROM the
// generate event. So every such edge folds != row on those two fields — which the B3 SoT-flip
// audit (pnpm audit:projection / b3:gate) correctly reports as DRIFT (a NO-GO). The forward fix
// makes NEW edges fold-consistent; this script repairs the EXISTING ones so the gate goes clean.
//
// WHAT. For every event-sourced edge (one whose fold is non-null), if its live created_by or
// created_at differs from fold(events), overwrite ONLY those two columns with the fold's values
// (the generate event is the source of truth). All other columns already match the fold
// (createKnowledgeEdge stored from/to/relation_type/weight/reasoning consistently), so they are
// left untouched — a row that drifts on some OTHER field is a SEPARATE concern the audit surfaces,
// not silently rewritten here. Event-LESS edges (no generate event → fold null) are skipped; they
// are anchored by the scoped genesis backfill instead.
//
// IDEMPOTENT. A row already matching its fold on created_by + created_at is skipped, so a re-run
// normalizes zero rows. Targeting ONLY those two fields (not the whole row) means a row with
// unrelated drift is never re-touched in a loop.
//
// NOT in the `pnpm test` chain — it needs a populated DB. Run it on a prod-CLONE (and on prod,
// before flipping PROJECTION_IS_WRITER=1).
//
// ORDER vs the genesis backfill (scripts/backfill-genesis-events.ts) is non-hazardous on two
// independent levels, so a genesis seed can NEVER mask a legacy bare-string created_by into the
// fold (the false-GREEN an adversarial review feared):
//   (1) PRIMARY — the genesis backfill is SCOPED (edgesWithOriginatingEvent): it SKIPS any edge
//       that already carries a `generate` event, so a legacy reconcile/POST edge is never seeded
//       at all, regardless of run order.
//   (2) BACKSTOP — even an unscoped seed attempt is FAIL-LOUD: writeEvent validates the seed
//       payload through GenesisExperimental → KnowledgeEdgeRowSnapshot (`created_by: z.record(...)`),
//       so a bare-string created_by THROWS at write time and can never be persisted (and would
//       also be rejected at fold time).
// Either way the fold always exposes the generate event's {actor_kind, actor_ref} object for this
// migration to repair. Pinned by the scoped-skip regression test in
// normalize-edge-created-by.db.test.ts. CI coverage is that DB test.
//
// CLI:
//   pnpm normalize:edge-created-by   # repair legacy edges; idempotent

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { type Db, type Tx, db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { edgeRowToSnapshot, gatherAndFoldKnowledgeEdgeWithMesh } from '@/server/projections/gather';
import { diffSnapshots } from '@/server/projections/snapshot-diff';
import { eq } from 'drizzle-orm';

type DbLike = Db | Tx;

export interface NormalizeCounts {
  checked: number;
  normalized: number;
}

/**
 * Repair legacy edges whose created_by / created_at diverge from fold(events). READ rows, fold
 * each, and UPDATE only created_by + created_at to the fold's values where they differ. Returns
 * { checked, normalized }. Idempotent. Exported so the DB test can drive it against the
 * testcontainer; the CLI main()/auto-run only fires as the entry point.
 */
export async function normalizeEdgeCreatedBy(db: DbLike): Promise<NormalizeCounts> {
  const rows = await db.select().from(knowledge_edge);
  // Build the live topology mesh ONCE from the rows we already read (archived_at IS NULL) and
  // fold each edge against it via the mesh-injected form — instead of the single-edge gather that
  // re-SELECTs the entire live edge set per edge (O(E²) → O(E)). Safe because this migration only
  // UPDATEs created_by/created_at, never archived_at or topology fields, so the mesh is invariant
  // across the loop.
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
