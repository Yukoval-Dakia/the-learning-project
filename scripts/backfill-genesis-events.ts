// YUK-471 W1 PR-A2a (B3 scoped, YUK-471) — genesis backfill: seed ONE experimental:genesis event
// per TRULY EVENT-LESS row.
//
// WHY. The W1 structural fold (foldKnowledgeNode / foldKnowledgeEdge) projects a
// `knowledge` / `knowledge_edge` row by replaying its `event` log. But every row that EXISTS
// before Wave 1 has NO originating event — the fold would project an empty world. This script
// closes the gap: for each EVENT-LESS live row it writes ONE system `experimental:genesis` event
// whose payload.row is a FULL snapshot of that row, so fold(genesis) == row. The reducers treat
// `experimental:genesis` as the trusted seed that establishes a row's initial projected state.
// It also writes the materialized_id_index entry (row.id → the genesis event id) so the node
// shell's reverse-index path (Q2) resolves a genesis-born id to its anchor.
//
// SCOPED — anchor only EVENT-LESS rows (B3, YUK-471). A row that is ALREADY event-sourced — a node
// with a genesis / auto_tag event or a materialized_id_index anchor (knowledgeNodesWithGenesisAnchor),
// or an edge with a generate / genesis event (edgesWithOriginatingEvent) — is SKIPPED. Anchoring it
// would be WRONG twice: (1) it re-folds correctly from its own log already (it does not need a base),
// and (2) a genesis snapshot of its CURRENT state is stamped at backfill time, which sorts LAST in
// the fold and would OVERWRITE the mutation-reducer output — masking any reducer drift that the B3
// audit exists to catch. Leaving event-sourced rows un-anchored makes the audit re-derive them
// through their reducers (real value-drift teeth) AND is the correct flip-prep (post-flip those rows
// fold from their own events; only event-less rows need a genesis base to mutate from).
//
// BEHAVIOR-PRESERVING (PR-A2a): this is a one-shot BACKFILL script, NOT wired into any live
// request path. It only ADDS event rows + index rows; it never mutates `knowledge` /
// `knowledge_edge`. The genesis events OPT OUT of the memory outbox (ingest_at = now at
// INSERT) so backfilling N rows does NOT flood mem0 (the outbox poller selects
// `WHERE ingest_at IS NULL`; a non-NULL stamp at INSERT skips the row — see WriteEventInput
// .ingest_at / ADR-0021).
//
// IDEMPOTENT (single-run). An already-event-sourced row is SKIPPED, and a genesis event is itself
// an "event-sourced" marker, so a row backfilled on a prior run is skipped on the next — re-running
// is a no-op. (The skip pre-scan is the event-sourced check above, not a genesis-only scan.) Each row's
// genesis event + its materialized_id_index entry are written in ONE transaction, so a crash
// mid-row leaves NEITHER and the re-run redoes both — closing the "event committed, index
// write lost, re-run skips the row → permanent index gap" hole (CodeRabbit MAJOR). NOTE: this
// is a one-shot maintenance script, NOT designed to run CONCURRENTLY with itself — two parallel
// runs could each pass the point-in-time pre-scan and write two genesis events for the same row
// (each uses a fresh newId(), so the event PK never collides). Run it once, not in parallel.
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
import type {
  GoalRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  KnowledgeRowSnapshotT,
  MistakeVariantRowSnapshotT,
} from '@/core/schema/event/genesis';
import { type Db, type Tx, db } from '@/db/client';
import { event, goal, knowledge, knowledge_edge, mistake_variant } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
// The SCOPED backfill skips already-event-sourced NODES — reuse the SAME genesis-anchor check the
// accept-time parity assert uses (genesis / auto_tag event, or a materialized_id_index anchor), so
// "event-sourced" means exactly the same thing on both sides. (YUK-471 W2: goalsWithGenesisAnchor
// is the goal analog; mistakeVariantsWithGenesisAnchor is the mistake_variant analog — a runtime
// create event / backfill genesis / index anchor.)
import {
  goalsWithGenesisAnchor,
  knowledgeNodesWithGenesisAnchor,
  mistakeVariantsWithGenesisAnchor,
} from '@/server/projections/parity';
import { and, eq, inArray, or } from 'drizzle-orm';

type DbLike = Db | Tx;
type KnowledgeRow = typeof knowledge.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;
type GoalRow = typeof goal.$inferSelect;
type MistakeVariantRow = typeof mistake_variant.$inferSelect;

const GENESIS_ACTION = 'experimental:genesis';
const GENESIS_ACTOR_REF = 'genesis-backfill';

export interface BackfillCounts {
  knowledge: { seeded: number; skipped: number };
  knowledge_edge: { seeded: number; skipped: number };
  goal: { seeded: number; skipped: number };
  mistake_variant: { seeded: number; skipped: number };
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

// Edge ids that are ALREADY event-sourced — they carry a `generate` (create/archive) or
// `experimental:genesis` event keyed on the edge, so the edge fold reproduces them from their OWN
// log. Only event-LESS edges (seed / pre-W1 legacy) need a backfilled genesis base. (The node-side
// equivalent is knowledgeNodesWithGenesisAnchor, imported from parity — it additionally treats a
// materialized_id_index anchor as event-sourced, which edges do not have.) This DOUBLES as the
// idempotency pre-scan: a previously-backfilled edge now carries a genesis event and is skipped.
async function edgesWithOriginatingEvent(db: DbLike, edgeIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (edgeIds.length === 0) return out;
  const rows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'knowledge_edge'),
        inArray(event.subject_id, edgeIds),
        or(eq(event.action, 'generate'), eq(event.action, GENESIS_ACTION)),
      ),
    );
  for (const r of rows) out.add(r.subject_id);
  return out;
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
  const rows = await db.select().from(knowledge);
  // SCOPED: skip rows already event-sourced (a genesis / auto_tag event, or a materialized_id_index
  // anchor) — they re-fold from their OWN log, so the B3 audit re-derives them through the reducers.
  // Anchoring an event-sourced row would MASK reducer drift (the genesis snapshot sorts LAST in the
  // fold and overwrites the mutation output). Only TRULY event-less rows (seed roots / pre-W1
  // legacy) need a genesis base. This also serves as the idempotency pre-scan: a previously
  // backfilled row now carries a genesis event and is treated as event-sourced → skipped.
  const eventSourced = await knowledgeNodesWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    // ATOMIC per row: the genesis event + its index entry commit together (see header) so a
    // crash can never leave the event without its anchor index row.
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
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
      await upsertMaterializedIdIndex(tx, {
        materialized_id: row.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'knowledge',
      });
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
  const rows = await db.select().from(knowledge_edge);
  // SCOPED: skip edges already event-sourced (a generate or genesis event keyed on the edge) — see
  // edgesWithOriginatingEvent. Only event-LESS edges need a genesis base. (Doubles as the
  // idempotency pre-scan.)
  const eventSourced = await edgesWithOriginatingEvent(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    // ATOMIC per row: genesis event + index entry commit together (see header).
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
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
      await upsertMaterializedIdIndex(tx, {
        materialized_id: row.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'knowledge_edge',
      });
    });
    seeded += 1;
  }
  return { seeded, skipped };
}

// goalRowToSnapshot — map a live `goal` DB row to GoalRowSnapshotT (the FULL row — goal has no
// derived/embed columns). Dates stay Date (GenesisExperimental's z.coerce.date() accepts both).
// scope_knowledge_ids defaults to [] at the column, so it is always a string[] here.
function goalRowToSnapshot(row: GoalRow): GoalRowSnapshotT {
  return {
    id: row.id,
    title: row.title,
    subject_id: row.subject_id,
    scope_knowledge_ids: row.scope_knowledge_ids ?? [],
    sequence_hint: row.sequence_hint,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Seed genesis events + index entries for every `goal` row lacking an originating event chain.
 * (YUK-471 W2.) Same shape as backfillKnowledgeGenesis (outbox opt-out, atomic per-row tx,
 * idempotent). Returns { seeded, skipped }.
 *
 * SCOPED (mirror the W1 node/edge backfill): skip goals already event-sourced — a goal with a
 * genesis / goal_scope proposal / status-scope action event, or a goal materialized_id_index
 * anchor (goalsWithGenesisAnchor). A proposal-accepted goal re-folds from its OWN proposal+rate
 * chain, so anchoring it with a current-state genesis snapshot would MASK reducer drift (the
 * genesis snapshot sorts last in the fold and overwrites the reducer output) — the exact reason
 * the design's "absence of genesis" predicate must NOT seed proposal-accepted goals. Only truly
 * EVENT-LESS goals (the manual at-entry path, goal-create.ts source='manual', which writes NO
 * event) need a genesis base. The pre-scan DOUBLES as the idempotency check (a previously
 * backfilled goal now carries a genesis event → skipped). timestamps verbatim from the row.
 */
export async function backfillGoalGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const rows = await db.select().from(goal);
  const eventSourced = await goalsWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    // ATOMIC per row: genesis event + index entry commit together (see header).
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: genesisEventId,
        actor_kind: 'system',
        actor_ref: GENESIS_ACTOR_REF,
        action: GENESIS_ACTION,
        subject_kind: 'goal',
        subject_id: row.id,
        outcome: 'success',
        payload: { row: goalRowToSnapshot(row) },
        ingest_at: now,
      });
      await upsertMaterializedIdIndex(tx, {
        materialized_id: row.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'goal',
      });
    });
    seeded += 1;
  }
  return { seeded, skipped };
}

// mistakeVariantRowToSnapshot — map a live `mistake_variant` DB row to MistakeVariantRowSnapshotT
// (the FULL row — no derived/embed/version columns). The fold-blind `cause_category` is snapshotted
// here (the backfill compensation, critic A4 — the same field the runtime create event carries).
// Dates stay Date (GenesisExperimental's z.coerce.date() accepts both). failure_reasons defaults to
// [] at the column, so it is always a string[] here.
function mistakeVariantRowToSnapshot(row: MistakeVariantRow): MistakeVariantRowSnapshotT {
  return {
    id: row.id,
    parent_question_id: row.parent_question_id,
    variant_question_id: row.variant_question_id,
    proposal_event_id: row.proposal_event_id,
    status: row.status as MistakeVariantRowSnapshotT['status'],
    failure_reasons: row.failure_reasons ?? [],
    cause_category: row.cause_category,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Seed genesis events + index entries for every `mistake_variant` row lacking a base anchor.
 * (YUK-471 W2 — the HARDEST entity; cause_category is fold-blind.) Same shape as backfillGoalGenesis
 * (outbox opt-out, atomic per-row tx, idempotent). Returns { seeded, skipped }.
 *
 * SCOPED (mirror the W1 node/edge + W2 goal backfill): skip variants already event-sourced — a
 * variant with a runtime `experimental:mistake_variant_create` event, a backfill
 * `experimental:genesis`, or a mistake_variant materialized_id_index anchor
 * (mistakeVariantsWithGenesisAnchor). A runtime-created variant re-folds from its OWN create + chain,
 * so anchoring it with a current-state genesis snapshot would MASK reducer drift (the genesis sorts
 * last in the fold and overwrites the reducer output). Only truly EVENT-LESS variants (pre-W2 rows
 * written by the imperative variant_gen INSERT before this wave) need a genesis base. The pre-scan
 * DOUBLES as the idempotency check. cause_category MUST go into the snapshot (fold-blindness
 * compensation). timestamps verbatim from the row. FK ORDER: AFTER question + event (mistake_variant
 * softly references parent_question_id + proposal_event_id) — handled by backfillGenesisEvents below.
 */
export async function backfillMistakeVariantGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const rows = await db.select().from(mistake_variant);
  const eventSourced = await mistakeVariantsWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    // ATOMIC per row: genesis event + index entry commit together (see header).
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: genesisEventId,
        actor_kind: 'system',
        actor_ref: GENESIS_ACTOR_REF,
        action: GENESIS_ACTION,
        subject_kind: 'mistake_variant',
        subject_id: row.id,
        outcome: 'success',
        payload: { row: mistakeVariantRowToSnapshot(row) },
        ingest_at: now,
      });
      await upsertMaterializedIdIndex(tx, {
        materialized_id: row.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'mistake_variant',
      });
    });
    seeded += 1;
  }
  return { seeded, skipped };
}

/**
 * Run all backfills in FK order (knowledge → knowledge_edge → goal → mistake_variant).
 * mistake_variant is last because it softly references question (parent_question_id /
 * variant_question_id) + event (proposal_event_id) — both already event-sourced upstream; the
 * mistake_variant genesis + index writes only ADD event/index rows, but the FK order keeps the
 * convention. Returns counts.
 */
export async function backfillGenesisEvents(
  db: DbLike,
  now: Date = new Date(),
): Promise<BackfillCounts> {
  const knowledgeCounts = await backfillKnowledgeGenesis(db, now);
  const edgeCounts = await backfillKnowledgeEdgeGenesis(db, now);
  const goalCounts = await backfillGoalGenesis(db, now);
  const mistakeVariantCounts = await backfillMistakeVariantGenesis(db, now);
  return {
    knowledge: knowledgeCounts,
    knowledge_edge: edgeCounts,
    goal: goalCounts,
    mistake_variant: mistakeVariantCounts,
  };
}

async function main(): Promise<void> {
  const counts = await backfillGenesisEvents(db);
  console.log('[backfill-genesis] knowledge:', JSON.stringify(counts.knowledge));
  console.log('[backfill-genesis] knowledge_edge:', JSON.stringify(counts.knowledge_edge));
  console.log('[backfill-genesis] goal:', JSON.stringify(counts.goal));
  console.log('[backfill-genesis] mistake_variant:', JSON.stringify(counts.mistake_variant));
  const totalSeeded =
    counts.knowledge.seeded +
    counts.knowledge_edge.seeded +
    counts.goal.seeded +
    counts.mistake_variant.seeded;
  const totalSkipped =
    counts.knowledge.skipped +
    counts.knowledge_edge.skipped +
    counts.goal.skipped +
    counts.mistake_variant.skipped;
  console.log(
    `[backfill-genesis] done — seeded ${totalSeeded} genesis event(s), skipped ${totalSkipped} already-seeded row(s).`,
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
