// Genesis backfill: seed ONE `experimental:genesis` event per TRULY event-less row (plus a
// materialized_id_index anchor where the entity enters the index), so the projection folds can
// reproduce rows that predate the event-sourced writers. The reducers treat genesis as the
// trusted seed of a row's initial projected state: fold(genesis) == row.
//
// Rows already event-sourced (an originating event, or an index anchor) are SKIPPED: they
// re-fold from their own log, and a genesis snapshot of their current state sorts LAST in the
// fold and would overwrite the reducer output — masking the reducer drift the parity audit
// exists to catch. The skip pre-scan doubles as the idempotency check, so re-running is a no-op.
//
// The script only ADDS event/index rows; it never mutates the entity tables. Genesis events
// stamp ingest_at = now at INSERT to opt out of the memory outbox (the poller selects
// `WHERE ingest_at IS NULL`; ADR-0021) so a backfill does not flood mem0. Each row's event +
// index entry commit in ONE transaction (a crash mid-row leaves neither and the re-run redoes
// both). Two parallel runs are NOT supported: both could pass the point-in-time pre-scan and
// double-seed the same row. Run it once, not in parallel.
//
// CLI:
//   pnpm db:backfill:genesis   # idempotent: seed genesis events + index for un-seeded rows
//
// The pipeline fns take a DbLike handle and are EXPORTED so the DB test can drive them; the
// main()/auto-run only fires when this module is the CLI entry point, so importing is
// side-effect-free.

// Load `.env` BEFORE importing `@/db/client` (the client throws on a missing DATABASE_URL at
// construction). Must be the first import (ESM evaluates an imported module's side effects
// before the importing module's later imports). Scripts load `.env`, NOT `.env.local`.
import './load-env';

import { and, eq, inArray, or } from 'drizzle-orm';
// ZodError is the genesis parse-barrier failure (writeEvent → parseEvent) — the only per-row
// data problem to accumulate. Anything else (connectivity / deadlock / constraint) is infra and
// must abort the whole backfill — see the catch blocks.
import { ZodError } from 'zod';
import { newId } from '@/core/ids';
import type {
  GoalRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  LearningItemRowSnapshotT,
  MistakeVariantRowSnapshotT,
} from '@/core/schema/event/genesis';
import { type Db, type Tx, db } from '@/db/client';
import {
  artifact,
  event,
  goal,
  item_calibration,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
  question_block,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  knowledgeLiveRowToSnapshot as knowledgeRowToSnapshot,
  knowledgeNodesWithGenesisAnchor,
} from '@/kernel/records/knowledge-node-history';
import { learningItemsWithGenesisAnchor } from '@/kernel/records/learning-items';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';
// Reuse the SAME genesis-anchor checks the accept-time parity assert uses, so "event-sourced"
// means exactly the same thing on both sides. Edges are the exception: they have no index
// anchor, only a generate / genesis event (edgesWithOriginatingEvent below).
import {
  artifactsWithGenesisAnchor,
  goalsWithGenesisAnchor,
  itemCalibrationsWithGenesisAnchor,
  mistakeVariantsWithGenesisAnchor,
  questionBlocksWithGenesisAnchor,
} from '@/server/projections/parity';
// Shared artifact / question_block / item_calibration row→snapshot mappers — the genesis
// backfill, the audit, and the parity assert all map through the SAME field-pick so the
// snapshot shape can't drift.
import {
  artifactRowToSnapshot,
  itemCalibrationRowToSnapshot,
  questionBlockRowToSnapshot,
} from '@/server/projections/snapshot-mappers';

type DbLike = Db | Tx;
type EdgeRow = typeof knowledge_edge.$inferSelect;
type GoalRow = typeof goal.$inferSelect;
type MistakeVariantRow = typeof mistake_variant.$inferSelect;
type LearningItemRow = typeof learning_item.$inferSelect;

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
  item_calibration: { seeded: number; skipped: number };
}

// The edge table has NO version and NO embed_*; the full structural snapshot IS the row.
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

// Edges already event-sourced carry a `generate` (create/archive) or `experimental:genesis`
// event keyed on the edge, so the fold reproduces them from their OWN log. Doubles as the
// idempotency pre-scan: a previously-backfilled edge now carries a genesis event and is
// skipped. Unlike nodes, edges have no materialized_id_index anchor.
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
        // outbox opt-out: a non-NULL ingest_at skips the memory poller (ADR-0021)
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

// The FULL row — goal has no derived/embed columns. Dates stay Date (z.coerce.date() accepts
// both); scope_knowledge_ids defaults to [] at the column.
function goalRowToSnapshot(row: GoalRow): GoalRowSnapshotT {
  return {
    id: row.id,
    title: row.title,
    subject_id: row.subject_id,
    scope_knowledge_ids: row.scope_knowledge_ids ?? [],
    // Snapshot the CURRENT scope_mode / declared_stage: omitting them would fold to the
    // column defaults ('explicit' / null) and drift parity against the live row.
    scope_mode: row.scope_mode,
    sequence_hint: row.sequence_hint,
    declared_stage: row.declared_stage,
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
 * Same shape as backfillKnowledgeGenesis. Only truly EVENT-LESS goals need a base — the manual
 * at-entry path (goal-create.ts source='manual') writes no event; a proposal-accepted goal
 * re-folds from its own proposal+rate chain. Timestamps verbatim from the row.
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

// The FULL row — no derived/embed/version columns. The fold-blind `cause_category` is snapshotted
// as backfill compensation (the same field the runtime create event carries). failure_reasons
// defaults to [] at the column.
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
 * Same shape as backfillGoalGenesis. cause_category MUST go into the snapshot (fold-blindness
 * compensation). Only truly EVENT-LESS variants (rows written by the imperative variant_gen
 * INSERT before the runtime create event existed) need a base.
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

// EXCLUDES the non-structural / derived columns (child_learning_item_ids / ai_score / due_at /
// reviewed_at): they have no write path the fold owns, so they are not part of the structural
// snapshot (mirrors the node shell's embed_* exclusion). user_pinned IS carried verbatim.
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
 * Same shape as backfillGoalGenesis. PER-ID genesis: hub + each child item gets its OWN genesis
 * event (subject_id = item.id), NOT one genesis per tree — each learning_item folds INDEPENDENTLY
 * (child_learning_item_ids is excluded from the snapshot, so the hub never depends on child state).
 * Only truly EVENT-LESS items (rows written by the imperative learning_intent / ai_dream INSERT)
 * need a base.
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
  // HUB-BEFORE-CHILD: stable sort with parentless (hub) rows first (Array.prototype.sort is
  // stable, so the seeded sequence is deterministic). This is a BINARY parentless-first
  // partition, NOT a true topo sort — sufficient because the learning_item tree is structurally
  // 2-level: the only writers of parent_learning_item_id set it to null (a hub) or the hub's id
  // (children), so no grandchildren exist. IF the model ever grows a deeper hierarchy, this MUST
  // become a real dependency topo sort (e.g. Kahn) so every node is anchored after its parent.
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

// artifactRowToSnapshot — map a live `artifact` DB row to ArtifactRowSnapshotT — is imported from the
// shared ./snapshot-mappers module (W3-C3 review dedup; see import block).

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

// Cap the per-row detail so a wholesale-bad table can't produce an unbounded error string (the message
// must stay operator-readable in a log/CI line). The remainder is summarised as "... and N more" — the
// full set re-derives on the next run after the shown batch is fixed.
const MAX_FAILURE_DETAIL = 50;

function throwIfBackfillFailures(
  entity: string,
  failures: BackfillRowFailure[],
  seeded: number,
): void {
  if (failures.length === 0) return;
  const shown = failures.slice(0, MAX_FAILURE_DETAIL);
  const detail = shown.map((f) => `  - ${f.id}: ${f.error}`).join('\n');
  const more =
    failures.length > MAX_FAILURE_DETAIL
      ? `\n  ... and ${failures.length - MAX_FAILURE_DETAIL} more`
      : '';
  throw new Error(
    `[backfill-genesis] ${entity}: ${failures.length} row(s) failed the genesis parse barrier ` +
      `(${seeded} row(s) seeded OK before the throw) — fix ALL of them in ONE data-fix pass (§9.3), ` +
      `then re-run:\n${detail}${more}`,
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
      // ACCUMULATE only the genesis parse-barrier failure (a ZodError from writeEvent → parseEvent on a
      // malformed snapshot — a real per-row §9.3 data problem). RE-THROW everything else IMMEDIATELY:
      // a db.insert / upsertMaterializedIdIndex infra failure (connectivity / deadlock / constraint) is
      // NOT a bad row, and silently recording it as one would let a transient/systemic failure pass the
      // flip gate as "N rows to fix" instead of aborting the whole backfill loud.
      if (!(err instanceof ZodError)) throw err;
      failures.push({ id: row.id, error: err.message });
    }
  }
  throwIfBackfillFailures('artifact', failures, seeded);
  return { seeded, skipped };
}

// questionBlockRowToSnapshot — map a live `question_block` DB row to QuestionBlockRowSnapshotT
// (EXCLUDING the legacy extracted_prompt_md column, design §5.2) — is imported from the shared
// ./snapshot-mappers module (W3-C3 review dedup; see import block).

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
      // ACCUMULATE only the genesis parse-barrier failure (a ZodError from writeEvent → parseEvent on a
      // malformed snapshot — a real per-row §9.3 data problem). RE-THROW everything else IMMEDIATELY:
      // a db.insert / upsertMaterializedIdIndex infra failure (connectivity / deadlock / constraint) is
      // NOT a bad row, and silently recording it as one would let a transient/systemic failure pass the
      // flip gate as "N rows to fix" instead of aborting the whole backfill loud.
      if (!(err instanceof ZodError)) throw err;
      failures.push({ id: row.id, error: err.message });
    }
  }
  throwIfBackfillFailures('question_block', failures, seeded);
  return { seeded, skipped };
}

/**
 * Seed genesis events for every `item_calibration` row lacking an anchor. (YUK-496 — ADR-0044 §7
 * item_calibration 例外, 方案 A.) Same shape as backfillQuestionBlockGenesis (outbox opt-out, atomic
 * per-row tx, idempotent, ZodError fail-loud accumulation) and likewise writes NO
 * materialized_id_index entry — item_calibration does NOT enter the index (the question_block §5.3
 * precedent: the row id is always the genesis event's subject_id). Returns { seeded, skipped }.
 *
 * SCOPED (mirror every sibling lane): skip rows already anchored (itemCalibrationsWithGenesisAnchor
 * — the anchor-only fold consumes genesis events exclusively, so an anchored row re-folds from its
 * own log). The pre-scan DOUBLES as the idempotency check (a previously-backfilled row carries a
 * genesis event → skipped).
 *
 * 方案 A BOUNDARY (documented, ticket-scoped): rows born AFTER this backfill by the untouched B1
 * writers (`runItemPriorBackfill` → `applyItemPrior`) are event-less until a LATER run of this
 * script anchors them — between runs, audit:projection reports them as drift (the honest event=truth
 * signal the owner accepted with 不动 B1 在线写逻辑; a post-anchor kt_json / b_calib write drifts the
 * same way). Re-running the script on a clone is the documented re-anchor path (gate flow order:
 * backfill → audit).
 */
export async function backfillItemCalibrationGenesis(
  db: DbLike,
  now: Date = new Date(),
): Promise<{ seeded: number; skipped: number }> {
  const rows = await db.select().from(item_calibration);
  const eventSourced = await itemCalibrationsWithGenesisAnchor(
    db,
    rows.map((r) => r.id),
  );
  let seeded = 0;
  let skipped = 0;
  // Mirror the W3-C3 fail-loud accumulation: a malformed snapshot is a per-row §9.3 data problem
  // (report ALL bad ids in one throw); an infra failure re-throws immediately.
  const failures: BackfillRowFailure[] = [];
  for (const row of rows) {
    if (eventSourced.has(row.id)) {
      skipped += 1;
      continue;
    }
    const genesisEventId = newId();
    try {
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          id: genesisEventId,
          actor_kind: 'system',
          actor_ref: GENESIS_ACTOR_REF,
          action: GENESIS_ACTION,
          subject_kind: 'item_calibration',
          subject_id: row.id,
          outcome: 'success',
          payload: { row: itemCalibrationRowToSnapshot(row) },
          ingest_at: now,
        });
      });
      seeded += 1;
    } catch (err) {
      // ACCUMULATE only the genesis parse-barrier failure (a ZodError from writeEvent → parseEvent on a
      // malformed snapshot); RE-THROW everything else IMMEDIATELY (mirror the artifact/question_block
      // lanes — an infra failure must not pass the gate as "N rows to fix").
      if (!(err instanceof ZodError)) throw err;
      failures.push({ id: row.id, error: err.message });
    }
  }
  throwIfBackfillFailures('item_calibration', failures, seeded);
  return { seeded, skipped };
}

/**
 * Run all backfills in FK order (knowledge → knowledge_edge → goal → mistake_variant → artifact →
 * learning_item → question_block → item_calibration).
 * mistake_variant softly references question (parent_question_id / variant_question_id) + event
 * (proposal_event_id); learning_item softly references artifact (primary_artifact_id) + event
 * (source_ref), so artifact is backfilled BEFORE learning_item (the order the learning_item docblock
 * anticipates); question_block is independent (mistake_variant references `question`, NOT
 * question_block) so it runs last. item_calibration (YUK-496) has NO FK to any projection table —
 * an independent lane at the end. The genesis + index writes only ADD event/index rows (no entity
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
  const itemCalibrationCounts = await backfillItemCalibrationGenesis(db, now);
  return {
    knowledge: knowledgeCounts,
    knowledge_edge: edgeCounts,
    goal: goalCounts,
    mistake_variant: mistakeVariantCounts,
    artifact: artifactCounts,
    learning_item: learningItemCounts,
    question_block: questionBlockCounts,
    item_calibration: itemCalibrationCounts,
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
  console.log('[backfill-genesis] item_calibration:', JSON.stringify(counts.item_calibration));
  const totalSeeded =
    counts.knowledge.seeded +
    counts.knowledge_edge.seeded +
    counts.goal.seeded +
    counts.mistake_variant.seeded +
    counts.artifact.seeded +
    counts.learning_item.seeded +
    counts.question_block.seeded +
    counts.item_calibration.seeded;
  const totalSkipped =
    counts.knowledge.skipped +
    counts.knowledge_edge.skipped +
    counts.goal.skipped +
    counts.mistake_variant.skipped +
    counts.artifact.skipped +
    counts.learning_item.skipped +
    counts.question_block.skipped +
    counts.item_calibration.skipped;
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
