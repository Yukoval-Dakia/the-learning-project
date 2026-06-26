// YUK-471 W3-B2 — projectQuestionBlock: the IO shell around the PURE question_block fold.
//
// The read→fold→write-through shell the question_block write sites (applyExtractionResult /
// applyRescue / persistStructured / mergeQuestions in block-structured-edit.ts + ingestion.ts) flip
// to as the SOLE writer of a `question_block` row WHEN the per-entity flag
// projectionIsWriter('question_block') is ON (design §6, added in C3). It:
//   1. GATHERS the superset of `event` rows that can affect `blockId` (the pure reducer filters
//      internally, but the shell over-collects — a missed event silently drops a mutation),
//   2. maps each DB row → the flat FoldEvent envelope,
//   3. calls foldQuestionBlock(blockId, foldEvents) (PURE),
//   4. WRITE-THROUGH: null → DELETE the row; else upsert the projected columns.
//
// EXCLUDED from the upsert: `extracted_prompt_md` (legacy deprecated column, schema.ts:180 — DROP
// deferred to Step 11.5). It is NOT fold truth (markdown views derive from `structured`, ADR-0002),
// so the snapshot omits it and the projection never writes it (a pre-existing legacy value is left
// untouched on conflict-update). Every OTHER column is fold truth (design §5.2).
//
// ── INERT (W3-B2, behaviour-preserving) ─────────────────────────────────────────────────────────
// This shell is ADDED but NOT yet called by any live write path (no double-write, no SoT flip —
// those are W3-C1/C3). The guarded variant in particular must NOT delete a pre-W3 row that folds to
// null: until backfill (C2) writes a genesis anchor for every block, a fold-null on an un-anchored
// row is fold-BLINDNESS, not a revert, so the guard keeps the imperative row.
//
// ── Gather + anchor kept LOCAL (deliberately, design §7 lane split) ─────────────────────────────
// The W1/W2 IO shells import gatherAndFoldX from the SHARED gather.ts (so the projection auditor
// reconstructs a row identically) and hasXGenesisAnchor from parity.ts. W3-B2's scope is the
// reducer + an INERT IO shell ONLY — the gather.ts extension + the backfill leg + the full
// assertQuestionBlockParity are C2/C3. So the Q1+Q2 gather + the event-table anchor check the shell
// NEEDS live HERE as private helpers; C2 hoists them into gather.ts/parity.ts (and switches Q2's
// jsonb-containment to the top-level `@>` form that hits the W3-C0 `event_payload_gin_idx`, design
// §5.2 F4). Keeping them local keeps this lane self-contained and inert.
//
// question_block does NOT enter materialized_id_index (design §5.3 — it has no minting indirection;
// the row id is ALWAYS the subject_id, so the anchor is always a subject-keyed event and the
// event-table check is complete — the ONE intentional asymmetry vs artifact, §9.4).
//
// Db|Tx polymorphic.

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { FoldEvent } from '@/core/projections/fold-event';
import { foldQuestionBlock } from '@/core/projections/question_block';
import type { QuestionBlockRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, question_block } from '@/db/schema';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// The base events that establish a question_block as event-sourced (reproducible by
// foldQuestionBlock). Both carry the FULL initial QuestionBlockRowSnapshot in payload.row
// (design §5.2, fork #2).
const QUESTION_BLOCK_ANCHOR_ACTIONS = [
  'experimental:genesis',
  'experimental:question_block_create',
] as const;

// rowToFoldEvent — map ONE `event` DB row to the flat FoldEvent envelope the reducer consumes.
// (Local copy of gather.ts's exported mapper; C2 collapses this onto the shared one when the
// question_block gather is hoisted into gather.ts.)
function rowToFoldEvent(row: EventRow): FoldEvent {
  return {
    id: row.id,
    created_at: row.created_at,
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    caused_by_event_id: row.caused_by_event_id ?? null,
  };
}

/**
 * Gather the superset of events affecting `blockId` and run the PURE question_block fold. READ-ONLY.
 *
 * The question_block gather is a TWO-QUERY merge gather (design §5.2, mirrors the W1 node merge Q3):
 *   - Q1: subject_kind='question_block' AND subject_id=blockId → genesis + question_block_create +
 *     edit-as-primary (every event keyed on blockId's OWN id).
 *   - Q2: the merge reverse query — an edit event is keyed on the PRIMARY block, so when blockId is
 *     an absorbed `merged_source` the event's subject_id is a DIFFERENT block and Q1 misses it.
 *     blockId lives only in payload.affected_blocks[].block_id; the jsonb-containment `@>` finds it.
 *
 * NOTE FOR C2: this Q2 uses the TOP-LEVEL `event.payload @> {affected_blocks:[{block_id}]}` form
 * (recursive containment) — the same shape the design's F4 GIN index `event_payload_gin_idx`
 * (jsonb_path_ops on the whole `payload` column, W3-C0) accelerates. Until that index lands Q2 is a
 * seq scan; INERT here, so harmless. C2 hoists this into the shared gather.ts (next to
 * gatherAndFoldKnowledgeNode's Q3) so the projection auditor reconstructs the row identically.
 *
 * Returns the projected row or null (block never created). Writes NOTHING.
 */
async function gatherAndFoldQuestionBlock(
  db: DbLike,
  blockId: string,
): Promise<QuestionBlockRowSnapshotT | null> {
  // ── Q1: events whose subject_id IS blockId ──────────────────────────────────────────────────
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'question_block'), eq(event.subject_id, blockId)));

  // ── Q2: edit events that ABSORB blockId as a merged_source (keyed on a DIFFERENT primary) ─────
  const q2 = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:edit_question_block_structured'),
        sql`${event.payload} @> ${JSON.stringify({ affected_blocks: [{ block_id: blockId }] })}::jsonb`,
      ),
    );

  // Dedup by event id (Q1/Q2 overlap when blockId is the primary of one edit and a merged_source of
  // another).
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2]) byId.set(r.id, r);

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldQuestionBlock(blockId, foldEvents);
}

/**
 * Does this `question_block` have a genesis/create anchor — i.e. is it event-sourced (reproducible
 * by foldQuestionBlock) at all? READ-ONLY. Used by the guarded write-through (a fold-null on a NON-
 * event-sourced block must NOT delete the imperative row) — mirrors hasArtifactGenesisAnchor /
 * hasGoalGenesisAnchor. NO materialized_id_index leg: question_block does not enter the index
 * (design §5.3) — the row id is ALWAYS the subject_id, so the anchor is always a subject-keyed event
 * and this event-table check is complete.
 */
async function hasQuestionBlockGenesisAnchor(db: DbLike, blockId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question_block'),
        eq(event.subject_id, blockId),
        inArray(event.action, [...QUESTION_BLOCK_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  return ev.length > 0;
}

/**
 * Project the current structural state of a single `question_block` from the event log and write it
 * through to the live `question_block` table. READ→FOLD→WRITE-THROUGH:
 *   - null  → DELETE FROM question_block WHERE id=blockId (block never existed / fully reverted),
 *   - row   → upsert (insert … onConflictDoUpdate target question_block.id) the projected columns.
 *
 * INERT in B2 (not wired into any live path). Db|Tx polymorphic (wired sites in C1/C3 call it inside
 * the write tx).
 *
 * @param db       Db or Tx (polymorphic).
 * @param blockId  the question_block row id to project.
 */
export async function projectQuestionBlock(db: DbLike, blockId: string): Promise<void> {
  const projected = await gatherAndFoldQuestionBlock(db, blockId);
  if (projected === null) {
    await db.delete(question_block).where(eq(question_block.id, blockId));
    return;
  }
  await upsertProjectedQuestionBlock(db, projected);
}

/**
 * The GUARDED question_block write-through (the SoT-flip row writer). Identical to
 * projectQuestionBlock EXCEPT the null branch: a fold of null DELETEs the live row ONLY when the
 * block HAS a genesis/create anchor (a genuine revert of an event-sourced block). A fold-null on an
 * UN-anchored block — a pre-W3 row the fold is blind to (no genesis backfill yet) — must NOT delete
 * the live row; that would destroy data on a normal edit whose target predates event-sourcing. This
 * is the keystone that lets the flip activate before every block is backfilled. Mirrors
 * projectArtifactGuarded / projectKnowledgeNodeGuarded.
 */
export async function projectQuestionBlockGuarded(db: DbLike, blockId: string): Promise<void> {
  const projected = await gatherAndFoldQuestionBlock(db, blockId);
  if (projected === null) {
    if (await hasQuestionBlockGenesisAnchor(db, blockId)) {
      // Genuine revert — the block was event-sourced and every creating event un-applied.
      await db.delete(question_block).where(eq(question_block.id, blockId));
    }
    // else: fold-blind pre-event-sourced block — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedQuestionBlock(db, projected);
}

// Shared upsert of the projected question_block columns. Covers every fold-truth column; EXCLUDES
// `extracted_prompt_md` (legacy deprecated — not in the snapshot, left untouched on conflict). The
// snapshot always carries an explicit value for every column below (jsonb columns may be null only
// where the table allows — `structured` / nullable text columns).
async function upsertProjectedQuestionBlock(
  db: DbLike,
  projected: QuestionBlockRowSnapshotT,
): Promise<void> {
  const set = {
    ingestion_session_id: projected.ingestion_session_id,
    source_document_id: projected.source_document_id,
    source_asset_ids: projected.source_asset_ids,
    page_spans: projected.page_spans,
    structured: projected.structured,
    figures: projected.figures,
    layout_quality: projected.layout_quality,
    reference_md: projected.reference_md,
    wrong_answer_md: projected.wrong_answer_md,
    image_refs: projected.image_refs,
    crop_refs: projected.crop_refs,
    visual_complexity: projected.visual_complexity,
    extraction_confidence: projected.extraction_confidence,
    status: projected.status,
    knowledge_hint: projected.knowledge_hint,
    merged_from_block_ids: projected.merged_from_block_ids,
    imported_question_id: projected.imported_question_id,
    imported_attempt_event_id: projected.imported_attempt_event_id,
    created_at: projected.created_at,
    updated_at: projected.updated_at,
    version: projected.version,
  } satisfies Partial<typeof question_block.$inferInsert>;
  await db
    .insert(question_block)
    .values({ id: projected.id, ...set } as typeof question_block.$inferInsert)
    .onConflictDoUpdate({
      target: question_block.id,
      set,
    });
}
