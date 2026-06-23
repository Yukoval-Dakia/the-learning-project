// YUK-471 W1 PR-A2a — genesis backfill: seed ONE experimental:genesis event per pre-W1 row.
//
// WHY. The W1 structural fold (foldKnowledgeNode / foldKnowledgeEdge) projects a
// `knowledge` / `knowledge_edge` row by replaying its `event` log. But every row that EXISTS
// before Wave 1 has NO originating event — the fold would project an empty world. This script
// closes the gap: for each live row it writes ONE system `experimental:genesis` event whose
// payload.row is a FULL snapshot of that row, so fold(genesis) == row. The reducers treat
// `experimental:genesis` as the trusted seed that establishes a row's initial projected state.
// It also writes the materialized_id_index entry (row.id → the genesis event id) so the node
// shell's reverse-index path (Q2) resolves a genesis-born id to its anchor.
//
// BEHAVIOR-PRESERVING (PR-A2a): this is a one-shot BACKFILL script, NOT wired into any live
// request path. It only ADDS event rows + index rows; it never mutates `knowledge` /
// `knowledge_edge`. The genesis events OPT OUT of the memory outbox (ingest_at = now at
// INSERT) so backfilling N rows does NOT flood mem0 (the outbox poller selects
// `WHERE ingest_at IS NULL`; a non-NULL stamp at INSERT skips the row — see WriteEventInput
// .ingest_at / ADR-0021).
//
// IDEMPOTENT. A row that already has an experimental:genesis event is SKIPPED (we pre-scan
// the existing genesis subject_ids per table). Re-running is a no-op. writeEvent itself is
// also PK-conflict-do-nothing, and upsertMaterializedIdIndex is onConflictDoNothing, so the
// belt-and-suspenders holds even under concurrent/partial runs.
//
// ORDER. knowledge rows first, THEN knowledge_edge rows — FK order (edges reference
// knowledge.id); also the node shell's Q2 wants the index populated before a node projects.
//
// CLI:
//   pnpm db:backfill:genesis   # idempotent: seed genesis events + index for un-seeded rows
//
// Like seed-synthetic.ts, the pipeline fns take a DbLike handle and are EXPORTED so the DB
// test can drive them against the testcontainer; the main()/auto-run only fires when this
// module is the CLI entry point, so importing it is side-effect-free.

// Load `.env` BEFORE importing `@/db/client` (the client throws on a missing DATABASE_URL at
// construction). Must be the first import (ESM evaluates an imported module's side effects
// before the importing module's later imports). Scripts load `.env`, NOT `.env.local`.
import './load-env';

import { newId } from '@/core/ids';
import type { KnowledgeEdgeRowSnapshotT, KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import { type Db, type Tx, db } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';
import { upsertMaterializedIdIndex } from '../src/server/projections/materialized-id-index';

type DbLike = Db | Tx;
type KnowledgeRow = typeof knowledge.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;

const GENESIS_ACTION = 'experimental:genesis';
const GENESIS_ACTOR_REF = 'genesis-backfill';

export interface BackfillCounts {
  knowledge: { seeded: number; skipped: number };
  knowledge_edge: { seeded: number; skipped: number };
}

// knowledgeRowToSnapshot — map a live `knowledge` DB row to KnowledgeRowSnapshotT, EXCLUDING
// the embed_* columns (embedding / embed_model / embed_version / embed_content_hash). Those
// are DERIVED maintenance state the fold does not own, so they are NOT part of the structural
// snapshot fold(genesis) reproduces (mirrors the node shell's embed_* exclusion). Dates stay
// Date — GenesisExperimental's z.coerce.date() accepts both Date and the jsonb ISO string.
function knowledgeRowToSnapshot(row: KnowledgeRow): KnowledgeRowSnapshotT {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    parent_id: row.parent_id,
    merged_from: row.merged_from,
    archived_at: row.archived_at,
    proposed_by_ai: row.proposed_by_ai,
    approval_status: row.approval_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

// edgeRowToSnapshot — map a live `knowledge_edge` DB row to KnowledgeEdgeRowSnapshotT. The
// edge table has NO version and NO embed_*; the full structural snapshot IS the row.
function edgeRowToSnapshot(row: EdgeRow): KnowledgeEdgeRowSnapshotT {
  return {
    id: row.id,
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type,
    weight: row.weight,
    created_by: row.created_by as Record<string, unknown>,
    reasoning: row.reasoning,
    created_at: row.created_at,
    archived_at: row.archived_at,
  };
}

// Pre-scan the set of row ids that ALREADY have a genesis event for one table (idempotency).
async function existingGenesisSubjectIds(
  db: DbLike,
  subjectKind: 'knowledge' | 'knowledge_edge',
): Promise<Set<string>> {
  const rows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(and(eq(event.action, GENESIS_ACTION), eq(event.subject_kind, subjectKind)));
  return new Set(rows.map((r) => r.subject_id));
}

/**
 * Seed genesis events + index entries for every `knowledge` row lacking one. READ rows, WRITE
 * one genesis event (ingest_at = now → outbox opt-out) + one materialized_id_index entry per
 * un-seeded row. Idempotent. Returns { seeded, skipped }.
 */
export async function backfillKnowledgeGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const existing = await existingGenesisSubjectIds(db, 'knowledge');
  const rows = await db.select().from(knowledge);
  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (existing.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    await writeEvent(db, {
      id: genesisEventId,
      actor_kind: 'system',
      actor_ref: GENESIS_ACTOR_REF,
      action: GENESIS_ACTION,
      subject_kind: 'knowledge',
      subject_id: row.id,
      outcome: 'success',
      payload: { row: knowledgeRowToSnapshot(row) },
      // OUTBOX OPT-OUT: stamp ingest_at non-NULL at INSERT so the memory poller
      // (WHERE ingest_at IS NULL) never picks up the backfill flood (ADR-0021).
      ingest_at: now,
    });
    await upsertMaterializedIdIndex(db, {
      materialized_id: row.id,
      anchor_event_id: genesisEventId,
      subject_kind: 'knowledge',
    });
    seeded += 1;
  }
  return { seeded, skipped };
}

/**
 * Seed genesis events + index entries for every `knowledge_edge` row lacking one. Same shape
 * as backfillKnowledgeGenesis (outbox opt-out, idempotent). Returns { seeded, skipped }.
 */
export async function backfillKnowledgeEdgeGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const existing = await existingGenesisSubjectIds(db, 'knowledge_edge');
  const rows = await db.select().from(knowledge_edge);
  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (existing.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    await writeEvent(db, {
      id: genesisEventId,
      actor_kind: 'system',
      actor_ref: GENESIS_ACTOR_REF,
      action: GENESIS_ACTION,
      subject_kind: 'knowledge_edge',
      subject_id: row.id,
      outcome: 'success',
      payload: { row: edgeRowToSnapshot(row) },
      ingest_at: now,
    });
    await upsertMaterializedIdIndex(db, {
      materialized_id: row.id,
      anchor_event_id: genesisEventId,
      subject_kind: 'knowledge_edge',
    });
    seeded += 1;
  }
  return { seeded, skipped };
}

/**
 * Run both backfills in FK order (knowledge first, then knowledge_edge). Returns the counts.
 */
export async function backfillGenesisEvents(
  db: DbLike,
  now: Date = new Date(),
): Promise<BackfillCounts> {
  const knowledgeCounts = await backfillKnowledgeGenesis(db, now);
  const edgeCounts = await backfillKnowledgeEdgeGenesis(db, now);
  return { knowledge: knowledgeCounts, knowledge_edge: edgeCounts };
}

async function main(): Promise<void> {
  const counts = await backfillGenesisEvents(db);
  console.log('[backfill-genesis] knowledge:', JSON.stringify(counts.knowledge));
  console.log('[backfill-genesis] knowledge_edge:', JSON.stringify(counts.knowledge_edge));
  console.log(
    `[backfill-genesis] done — seeded ${counts.knowledge.seeded + counts.knowledge_edge.seeded} genesis event(s), skipped ${counts.knowledge.skipped + counts.knowledge_edge.skipped} already-seeded row(s).`,
  );
}

// CLI-gate: only run + exit when invoked as the CLI entry point so the DB test can import the
// pipeline fns without the top-level run firing.
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('backfill-genesis-events.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[backfill-genesis] failed:', err);
      process.exit(1);
    });
}
