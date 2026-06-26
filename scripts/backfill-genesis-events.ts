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
  ArtifactRowSnapshotT,
  GoalRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  KnowledgeRowSnapshotT,
  LearningItemRowSnapshotT,
  MistakeVariantRowSnapshotT,
  QuestionBlockRowSnapshotT,
} from '@/core/schema/event/genesis';
import { type Db, type Tx, db } from '@/db/client';
import {
  artifact,
  event,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
  question_block,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
// The SCOPED backfill skips already-event-sourced NODES — reuse the SAME genesis-anchor check the
// accept-time parity assert uses (genesis / auto_tag event, or a materialized_id_index anchor), so
// "event-sourced" means exactly the same thing on both sides. (YUK-471 W2: goalsWithGenesisAnchor
// is the goal analog; mistakeVariantsWithGenesisAnchor is the mistake_variant analog;
// learningItemsWithGenesisAnchor is the learning_item analog — a genesis / index anchor. YUK-471
// W3-C2: artifactsWithGenesisAnchor (genesis/create event OR index anchor) is the artifact analog;
// questionBlocksWithGenesisAnchor (genesis/create event ONLY — question_block is not in the index)
// is the question_block analog.)
import {
  artifactsWithGenesisAnchor,
  goalsWithGenesisAnchor,
  knowledgeNodesWithGenesisAnchor,
  learningItemsWithGenesisAnchor,
  mistakeVariantsWithGenesisAnchor,
  questionBlocksWithGenesisAnchor,
} from '@/server/projections/parity';
import { and, eq, inArray, or } from 'drizzle-orm';

type DbLike = Db | Tx;
type KnowledgeRow = typeof knowledge.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;
type GoalRow = typeof goal.$inferSelect;
type MistakeVariantRow = typeof mistake_variant.$inferSelect;
type LearningItemRow = typeof learning_item.$inferSelect;
type ArtifactRow = typeof artifact.$inferSelect;
type QuestionBlockRow = typeof question_block.$inferSelect;

const GENESIS_ACTION = 'experimental:genesis';
const GENESIS_ACTOR_REF = 'genesis-backfill';

export interface BackfillCounts {
  knowledge: { seeded: number; skipped: number };
  knowledge_edge: { seeded: number; skipped: number };
  goal: { seeded: number; skipped: number };
  mistake_variant: { seeded: number; skipped: number };
  artifact: { seeded: number; skipped: number };
  learning_item: { seeded: number; skipped: number };
  question_block: { seeded: number; skipped: number };
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

// learningItemRowToSnapshot — map a live `learning_item` DB row to LearningItemRowSnapshotT,
// EXCLUDING the non-structural / derived columns (child_learning_item_ids / ai_score / due_at /
// reviewed_at — design §3①). Those have no write path the fold owns, so they are NOT part of the
// structural snapshot fold(genesis) reproduces (mirrors the node shell's embed_* exclusion).
// user_pinned IS retained (carried verbatim). Dates stay Date (z.coerce.date() accepts both).
// knowledge_ids defaults to [] at the column, so it is always a string[] here.
function learningItemRowToSnapshot(row: LearningItemRow): LearningItemRowSnapshotT {
  return {
    id: row.id,
    source: row.source,
    source_ref: row.source_ref,
    title: row.title,
    content: row.content,
    knowledge_ids: row.knowledge_ids ?? [],
    primary_artifact_id: row.primary_artifact_id,
    parent_learning_item_id: row.parent_learning_item_id,
    status: row.status,
    user_pinned: row.user_pinned,
    completed_at: row.completed_at,
    dismissed_at: row.dismissed_at,
    archived_at: row.archived_at,
    archived_reason: row.archived_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Seed genesis events + index entries for every `learning_item` row lacking a genesis anchor.
 * (YUK-471 W2.) Same shape as backfillGoalGenesis (outbox opt-out, atomic per-row tx, idempotent).
 * Returns { seeded, skipped }.
 *
 * PER-ID genesis (design §3②/§3⑤): hub + each child item gets its OWN genesis event (subject_id =
 * item.id), NOT one genesis per tree — each learning_item folds INDEPENDENTLY (child_learning_item_ids
 * is excluded from the snapshot, so the hub never depends on child state).
 *
 * C3 HUB-BEFORE-CHILD TOPO ORDER (design §3⑦): the rows are seeded sorted so a parent is anchored
 * BEFORE its children (rows with parent_learning_item_id === null first, then children). The genesis
 * writes only ADD event/index rows (no learning_item FK on parent_learning_item_id is enforced here),
 * but the deterministic parent-first order keeps the convention + makes the seeded sequence stable.
 *
 * SCOPED (mirror the W1 node/edge + W2 goal/mistake_variant backfill): skip items already
 * event-sourced — an item with a backfill `experimental:genesis` or a learning_item
 * materialized_id_index anchor (learningItemsWithGenesisAnchor). The pre-scan DOUBLES as the
 * idempotency check (a previously backfilled item now carries a genesis event → skipped). Only truly
 * EVENT-LESS items (pre-W2 rows written by the imperative learning_intent / ai_dream INSERT before
 * this wave) need a genesis base. timestamps verbatim from the row. FK ORDER: AFTER artifact + event
 * (learning_item softly references primary_artifact_id + source_ref→event) — handled by
 * backfillGenesisEvents below.
 */
export async function backfillLearningItemGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const rows = await db.select().from(learning_item);
  const eventSourced = await learningItemsWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  // C3 HUB-BEFORE-CHILD: stable sort with parentless (hub) rows first, then children. Among rows
  // of the same parent-ness the input order is preserved (Array.prototype.sort is stable), so the
  // seeded sequence is deterministic.
  //
  // 2-LEVEL TREE ASSUMPTION (A7): this is a BINARY parentless-first partition, NOT a true topo sort
  // — it only guarantees every hub precedes every child, not that an arbitrary grandchild follows
  // its parent. That is sufficient because the learning_item tree is structurally 2-level by the
  // current data model: the ONLY writers of parent_learning_item_id set it to either null (a hub:
  // learning_intent hub / ai_dream single item) or the hub's id (atomic/long children of that hub
  // — learning_intent.ts) — no site ever points a child at another child, so no grandchildren
  // exist. IF the model ever grows a deeper hierarchy (>2 levels), this MUST become a real
  // dependency topo sort (e.g. Kahn) so every node is anchored after its parent.
  const ordered = [...rows].sort((a, b) => {
    const aHub = a.parent_learning_item_id === null ? 0 : 1;
    const bHub = b.parent_learning_item_id === null ? 0 : 1;
    return aHub - bHub;
  });
  let seeded = 0;
  let skipped = 0;
  for (const row of ordered) {
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
        subject_kind: 'learning_item',
        subject_id: row.id,
        outcome: 'success',
        payload: { row: learningItemRowToSnapshot(row) },
        ingest_at: now,
      });
      await upsertMaterializedIdIndex(tx, {
        materialized_id: row.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'learning_item',
      });
    });
    seeded += 1;
  }
  return { seeded, skipped };
}

// artifactRowToSnapshot — map a live `artifact` DB row to ArtifactRowSnapshotT. artifact has NO
// derived/embed columns (design §5.1), so the FULL 22-column row IS the snapshot — every column is
// carried verbatim. The jsonb columns (body_blocks / attrs / tool_state / verification_summary /
// generated_by / verified_by / history) are passed through untouched (the snapshot REUSES the
// canonical business schemas for them, so writeEvent's parseEvent barrier validates them as ground
// truth). Dates stay Date (GenesisExperimental's z.coerce.date() accepts both Date and the jsonb ISO
// string). The array columns default to [] at the table, so they are always present.
function artifactRowToSnapshot(row: ArtifactRow): ArtifactRowSnapshotT {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    parent_artifact_id: row.parent_artifact_id,
    knowledge_ids: row.knowledge_ids ?? [],
    intent_source: row.intent_source,
    source: row.source,
    source_ref: row.source_ref,
    body_blocks: row.body_blocks,
    attrs: row.attrs ?? {},
    tool_kind: row.tool_kind,
    tool_state: row.tool_state,
    generation_status: row.generation_status,
    verification_status: row.verification_status,
    verification_summary: row.verification_summary,
    generated_by: row.generated_by,
    verified_by: row.verified_by,
    history: row.history ?? [],
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

// W3-C3 FLIP-GATE HARDENING — per-row backfill error accumulation. A malformed row (e.g. an
// out-of-range structured/figure bbox failing the strict QuestionBlockRowSnapshot / ArtifactRowSnapshot
// parse at writeEvent) aborts ONLY its OWN per-row tx; the loop CONTINUES and records { id, error }.
// After the whole scan, if ANY row failed, throw ONCE listing EVERY bad id — so the owner fixes all bad
// rows in a SINGLE §9.3 data-fix pass instead of re-running the gate N times (fix one → hit the next →
// rerun → …). Successfully-seeded rows already committed their own txs and are NOT rolled back (the
// aggregate throw is a post-scan REPORT, not a transaction boundary). This is the form runB3Gate's
// step-2 backfill inherits (it calls backfillGenesisEvents → these per-entity functions).
interface BackfillRowFailure {
  id: string;
  error: string;
}

function throwIfBackfillFailures(entity: string, failures: BackfillRowFailure[]): void {
  if (failures.length === 0) return;
  const detail = failures.map((f) => `  - ${f.id}: ${f.error}`).join('\n');
  throw new Error(
    `[backfill-genesis] ${entity}: ${failures.length} row(s) failed the genesis parse barrier — ` +
      `fix ALL of them in ONE data-fix pass (§9.3), then re-run:\n${detail}`,
  );
}

/**
 * Seed genesis events + index entries for every `artifact` row lacking a base anchor. (YUK-471 W3-C2.)
 * Same shape as backfillGoalGenesis (outbox opt-out, atomic per-row tx, idempotent). Returns
 * { seeded, skipped }.
 *
 * SCOPED (mirror the W1/W2 backfills): skip artifacts already event-sourced — a row with a runtime
 * `experimental:artifact_create` event, a backfill `experimental:genesis`, or an artifact
 * materialized_id_index anchor (artifactsWithGenesisAnchor). A runtime-created artifact re-folds from
 * its OWN create + edit/lifecycle chain, so anchoring it with a current-state genesis snapshot would
 * MASK reducer drift (the genesis sorts last in the fold and overwrites the reducer output). Only
 * truly EVENT-LESS artifacts (pre-W3 rows written by the imperative INSERT sites before this wave)
 * need a genesis base. The pre-scan DOUBLES as the idempotency check.
 *
 * artifact ENTERS the materialized_id_index (subject_kind='artifact', design §5.3 — the ONE
 * intentional asymmetry vs question_block, which does NOT), so each genesis writes an index entry too.
 *
 * FAIL-LOUD (NOT skip/clamp): the snapshot is built by faithful field-pick; writeEvent's parseEvent
 * barrier then validates it against the strict ArtifactRowSnapshot. A row whose body_blocks /
 * generated_by / verification_summary violate the canonical business schemas throws at writeEvent,
 * aborting the per-row tx → the whole backfill fails loud (genesis is ground truth; a malformed row
 * is a real data problem, not a row to silently drop). timestamps verbatim from the row.
 */
export async function backfillArtifactGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const rows = await db.select().from(artifact);
  const eventSourced = await artifactsWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  // W3-C3 — accumulate per-row parse failures, throw ONCE after the scan (see throwIfBackfillFailures).
  const failures: BackfillRowFailure[] = [];
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    try {
      // ATOMIC per row: genesis event + index entry commit together (see header).
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          id: genesisEventId,
          actor_kind: 'system',
          actor_ref: GENESIS_ACTOR_REF,
          action: GENESIS_ACTION,
          subject_kind: 'artifact',
          subject_id: row.id,
          outcome: 'success',
          payload: { row: artifactRowToSnapshot(row) },
          ingest_at: now,
        });
        await upsertMaterializedIdIndex(tx, {
          materialized_id: row.id,
          anchor_event_id: genesisEventId,
          subject_kind: 'artifact',
        });
      });
      seeded += 1;
    } catch (err) {
      failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  throwIfBackfillFailures('artifact', failures);
  return { seeded, skipped };
}

// questionBlockRowToSnapshot — map a live `question_block` DB row to QuestionBlockRowSnapshotT,
// EXCLUDING the LEGACY `extracted_prompt_md` column (the snapshot omits it — markdown views derive
// from `structured`, ADR-0002; DROP deferred to Step 11.5). This is the "strip the excluded column
// BEFORE the snapshot is built" step (design §5.2): the strict QuestionBlockRowSnapshot would
// `unrecognized_keys`-reject a payload carrying extracted_prompt_md, so it is never picked. Every
// OTHER column is fold truth (carried verbatim). `structured` / `figures` REUSE the canonical
// StructuredQuestion / FigureRef schemas (incl. the 0-1 normalized BBox refinements) — a row whose
// structured/figure bbox is out of range FAILS the strict parse at writeEvent (fail-loud, NOT
// clamp; see backfillQuestionBlockGenesis). Dates stay Date (z.coerce.date() accepts both).
function questionBlockRowToSnapshot(row: QuestionBlockRow): QuestionBlockRowSnapshotT {
  return {
    id: row.id,
    ingestion_session_id: row.ingestion_session_id,
    source_document_id: row.source_document_id,
    source_asset_ids: row.source_asset_ids ?? [],
    page_spans: row.page_spans ?? [],
    structured: row.structured ?? null,
    figures: row.figures ?? [],
    layout_quality: row.layout_quality,
    reference_md: row.reference_md,
    wrong_answer_md: row.wrong_answer_md,
    image_refs: row.image_refs ?? [],
    crop_refs: row.crop_refs ?? [],
    visual_complexity: row.visual_complexity,
    extraction_confidence: row.extraction_confidence,
    status: row.status,
    knowledge_hint: row.knowledge_hint,
    merged_from_block_ids: row.merged_from_block_ids ?? [],
    imported_question_id: row.imported_question_id,
    imported_attempt_event_id: row.imported_attempt_event_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
    // EXCLUDED: extracted_prompt_md (legacy deprecated — stripped before parse, design §5.2).
  };
}

/**
 * Seed genesis events for every `question_block` row lacking a base anchor. (YUK-471 W3-C2.) Same
 * shape as backfillArtifactGenesis (outbox opt-out, atomic per-row tx, idempotent) EXCEPT it writes
 * NO materialized_id_index entry — question_block does NOT enter the index (design §5.3 — the row id
 * is always the subject_id, the anchor is always a subject-keyed event). Returns { seeded, skipped }.
 *
 * SCOPED (mirror the W1/W2/artifact backfills): skip blocks already event-sourced — a row with a
 * runtime `experimental:question_block_create` or a backfill `experimental:genesis`
 * (questionBlocksWithGenesisAnchor, event leg only). The pre-scan DOUBLES as the idempotency check.
 * Only truly EVENT-LESS blocks (pre-W3 rows written by the imperative OCR/rescue/docx INSERT before
 * this wave) need a genesis base.
 *
 * FAIL-LOUD on the C1-δ legacy-bbox / out-of-range rows (NOT skip/clamp): the snapshot omits the
 * legacy extracted_prompt_md column then field-picks the rest; writeEvent's parseEvent barrier
 * validates against the strict QuestionBlockRowSnapshot. `page_spans` is deliberately tolerant (raw
 * 4-number bbox, not the 0-1 BBox) so a faithful coordinate envelope never false-rejects, and
 * extraction_confidence is DB-CHECK-guaranteed in [0,1]; but `structured`/`figures` reuse the
 * canonical schemas (0-1 normalized BBox + sum refinements). A row whose structured/figure bbox is
 * out of range throws at writeEvent → the per-row tx aborts → the whole backfill fails loud. That is
 * a genuine data-integrity problem (genesis is ground truth) the design routes to the §9.3 owner
 * data-fix follow-up, NOT a row this backfill silently clamps or drops.
 */
export async function backfillQuestionBlockGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const rows = await db.select().from(question_block);
  const eventSourced = await questionBlocksWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  // W3-C3 — accumulate per-row parse failures (the bad-bbox rows the docblock above warns about), throw
  // ONCE after the scan so the owner fixes EVERY bad block in one §9.3 pass (see throwIfBackfillFailures).
  const failures: BackfillRowFailure[] = [];
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    try {
      // ATOMIC per row: ONLY the genesis event (no index entry — question_block is not in the index).
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          id: genesisEventId,
          actor_kind: 'system',
          actor_ref: GENESIS_ACTOR_REF,
          action: GENESIS_ACTION,
          subject_kind: 'question_block',
          subject_id: row.id,
          outcome: 'success',
          payload: { row: questionBlockRowToSnapshot(row) },
          ingest_at: now,
        });
      });
      seeded += 1;
    } catch (err) {
      failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  throwIfBackfillFailures('question_block', failures);
  return { seeded, skipped };
}

/**
 * Run all backfills in FK order (knowledge → knowledge_edge → goal → mistake_variant → artifact →
 * learning_item → question_block).
 * mistake_variant softly references question (parent_question_id / variant_question_id) + event
 * (proposal_event_id); learning_item softly references artifact (primary_artifact_id) + event
 * (source_ref), so artifact is backfilled BEFORE learning_item (the order the learning_item docblock
 * anticipates); question_block is independent (mistake_variant references `question`, NOT
 * question_block) so it runs last. The genesis + index writes only ADD event/index rows (no entity
 * FK is enforced here — materialized_id_index has no FK to the entity tables), so the order is a
 * stable-output convention, not a hard constraint. Returns counts.
 */
export async function backfillGenesisEvents(
  db: DbLike,
  now: Date = new Date(),
): Promise<BackfillCounts> {
  const knowledgeCounts = await backfillKnowledgeGenesis(db, now);
  const edgeCounts = await backfillKnowledgeEdgeGenesis(db, now);
  const goalCounts = await backfillGoalGenesis(db, now);
  const mistakeVariantCounts = await backfillMistakeVariantGenesis(db, now);
  const artifactCounts = await backfillArtifactGenesis(db, now);
  const learningItemCounts = await backfillLearningItemGenesis(db, now);
  const questionBlockCounts = await backfillQuestionBlockGenesis(db, now);
  return {
    knowledge: knowledgeCounts,
    knowledge_edge: edgeCounts,
    goal: goalCounts,
    mistake_variant: mistakeVariantCounts,
    artifact: artifactCounts,
    learning_item: learningItemCounts,
    question_block: questionBlockCounts,
  };
}

async function main(): Promise<void> {
  const counts = await backfillGenesisEvents(db);
  console.log('[backfill-genesis] knowledge:', JSON.stringify(counts.knowledge));
  console.log('[backfill-genesis] knowledge_edge:', JSON.stringify(counts.knowledge_edge));
  console.log('[backfill-genesis] goal:', JSON.stringify(counts.goal));
  console.log('[backfill-genesis] mistake_variant:', JSON.stringify(counts.mistake_variant));
  console.log('[backfill-genesis] artifact:', JSON.stringify(counts.artifact));
  console.log('[backfill-genesis] learning_item:', JSON.stringify(counts.learning_item));
  console.log('[backfill-genesis] question_block:', JSON.stringify(counts.question_block));
  const totalSeeded =
    counts.knowledge.seeded +
    counts.knowledge_edge.seeded +
    counts.goal.seeded +
    counts.mistake_variant.seeded +
    counts.artifact.seeded +
    counts.learning_item.seeded +
    counts.question_block.seeded;
  const totalSkipped =
    counts.knowledge.skipped +
    counts.knowledge_edge.skipped +
    counts.goal.skipped +
    counts.mistake_variant.skipped +
    counts.artifact.skipped +
    counts.learning_item.skipped +
    counts.question_block.skipped;
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
