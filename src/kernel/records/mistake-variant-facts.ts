// MistakeVariant facts: complete runtime creation and legacy genesis recording,
// shared history/anchor reads, and the canonical full-row materialization.
// Callers retain their transactions, locks, and lifecycle policies.

import { and, eq, inArray } from 'drizzle-orm';

import { newId } from '@/core/ids';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import type { MistakeVariantRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, materialized_id_index, mistake_variant } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// Pick exactly the nine structural fields. Preserve the supplied status/reasons so
// only the live-row mapper normalizes legacy values; projected rows pass through.
function pickMistakeVariantFields<Status extends string, Reasons extends string[] | null>(
  row: Omit<MistakeVariantRowSnapshotT, 'status' | 'failure_reasons'> & {
    status: Status;
    failure_reasons: Reasons;
  },
) {
  return {
    id: row.id,
    parent_question_id: row.parent_question_id,
    variant_question_id: row.variant_question_id,
    proposal_event_id: row.proposal_event_id,
    status: row.status,
    failure_reasons: row.failure_reasons,
    cause_category: row.cause_category,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Pick snapshot fields from a live variant row without Zod parsing. */
export function mistakeVariantLiveRowToSnapshot(row: {
  id: string;
  parent_question_id: string;
  variant_question_id: string | null;
  proposal_event_id: string | null;
  status: string;
  failure_reasons: string[] | null;
  cause_category: string | null;
  created_at: Date;
  updated_at: Date;
}): MistakeVariantRowSnapshotT {
  const snapshot = pickMistakeVariantFields(row);
  return {
    ...snapshot,
    // status is free text; the wired writers only set the snapshot enum values.
    status: snapshot.status as MistakeVariantRowSnapshotT['status'],
    failure_reasons: snapshot.failure_reasons ?? [],
  };
}

/** Record a complete runtime draft base, anchor it, then materialize in the caller's tx. */
export async function createMistakeVariantDraft(
  tx: Tx,
  input: {
    id: string;
    parentQuestionId: string;
    proposalEventId: string;
    causeCategory: string;
    now: Date;
  },
): Promise<void> {
  const { id, parentQuestionId, proposalEventId, causeCategory, now } = input;
  // cause_category is fold-blind: the BASE must carry the complete initial row.
  const baseRow = {
    id,
    parent_question_id: parentQuestionId,
    variant_question_id: null,
    proposal_event_id: proposalEventId,
    status: 'draft' as const,
    failure_reasons: [],
    cause_category: causeCategory,
    created_at: now,
    updated_at: now,
  };

  // Generate the event id after constructing the base, as on the original path.
  const createEventId = newId();
  await writeEvent(tx, {
    id: createEventId,
    actor_kind: 'agent',
    actor_ref: 'variant_gen',
    action: 'experimental:mistake_variant_create',
    subject_kind: 'mistake_variant',
    subject_id: id,
    outcome: 'success',
    payload: { row: baseRow },
    caused_by_event_id: proposalEventId,
    // Use the same Date for the base and event; ingestion remains opted out.
    created_at: now,
    ingest_at: now,
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: id,
    anchor_event_id: createEventId,
    subject_kind: 'mistake_variant',
  });
  await projectMistakeVariant(tx, id);
}

/** Record a legacy row's genesis and anchor without projecting or changing the live row. */
export async function recordMistakeVariantGenesis(
  tx: Tx,
  input: {
    row: Parameters<typeof mistakeVariantLiveRowToSnapshot>[0];
    genesisEventId: string;
    ingestAt: Date;
  },
): Promise<void> {
  const { row, genesisEventId, ingestAt } = input;
  await writeEvent(tx, {
    id: genesisEventId,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'mistake_variant',
    subject_id: row.id,
    outcome: 'success',
    payload: { row: mistakeVariantLiveRowToSnapshot(row) },
    ingest_at: ingestAt,
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: row.id,
    anchor_event_id: genesisEventId,
    subject_kind: 'mistake_variant',
  });
}

/**
 * Gather the events affecting `mvId` and run the pure mistake_variant fold. The base
 * event carries the proposal id; the lifecycle events are chained to that proposal, not
 * the variant row. Returns the projected row or null.
 */
export async function gatherAndFoldMistakeVariant(
  db: DbLike,
  mvId: string,
): Promise<MistakeVariantRowSnapshotT | null> {
  // Step 1: the base event (create or genesis) keyed on the variant id.
  const baseRows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'mistake_variant'), eq(event.subject_id, mvId)));

  const byId = new Map<string, EventRow>();
  for (const r of baseRows) byId.set(r.id, r);

  // Read the proposal_event_id off the base snapshot (create/genesis payload.row). Without a base
  // there is no row to fold (mvId never created) — return null without a second query.
  const proposalIds = new Set<string>();
  for (const r of baseRows) {
    if (r.action !== 'experimental:mistake_variant_create' && r.action !== 'experimental:genesis') {
      continue;
    }
    const payloadRow = (r.payload as { row?: { proposal_event_id?: unknown } } | null)?.row;
    const pid = payloadRow?.proposal_event_id;
    if (typeof pid === 'string' && pid.length > 0) proposalIds.add(pid);
  }

  // Step 2: the caused_by chain (accept/dismiss rate, verify, retract correct).
  if (proposalIds.size > 0) {
    const chained = await db
      .select()
      .from(event)
      .where(
        and(
          inArray(event.action, ['rate', 'correct', 'experimental:variant_verify']),
          inArray(event.caused_by_event_id, [...proposalIds]),
        ),
      );
    for (const r of chained) byId.set(r.id, r);
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldMistakeVariant(mvId, foldEvents);
}

// ── mistake_variant genesis-anchor helpers ────────────────────────────────────────────────────
//
// A variant is event-sourced when it has a create/genesis base event or an index anchor.
// Lifecycle events mutate an existing row and are not anchors on their own.

const MISTAKE_VARIANT_ANCHOR_ACTIONS = [
  'experimental:mistake_variant_create',
  'experimental:genesis',
] as const;

/** Whether a variant has a base anchor the fold can reproduce. */
export async function hasMistakeVariantGenesisAnchor(db: DbLike, mvId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'mistake_variant'),
        eq(event.subject_id, mvId),
        inArray(event.action, [...MISTAKE_VARIANT_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, mvId),
        eq(materialized_id_index.subject_kind, 'mistake_variant'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/** Batch form; also serves as the backfill's idempotency pre-scan. */
export async function mistakeVariantsWithGenesisAnchor(
  db: DbLike,
  mvIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (mvIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'mistake_variant'),
        inArray(event.subject_id, mvIds),
        inArray(event.action, [...MISTAKE_VARIANT_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, mvIds),
        eq(materialized_id_index.subject_kind, 'mistake_variant'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

/**
 * Re-project one `mistake_variant`. A fold of null deletes the row; otherwise upsert the
 * full row.
 */
async function projectMistakeVariant(db: DbLike, mvId: string): Promise<void> {
  const projected = await gatherAndFoldMistakeVariant(db, mvId);
  if (projected === null) {
    await db.delete(mistake_variant).where(eq(mistake_variant.id, mvId));
    return;
  }
  await upsertProjectedMistakeVariant(db, projected);
}

/**
 * Guarded write-through: a fold of null deletes only when the row has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
 */
export async function projectMistakeVariantGuarded(db: DbLike, mvId: string): Promise<void> {
  const projected = await gatherAndFoldMistakeVariant(db, mvId);
  if (projected === null) {
    if (await hasMistakeVariantGenesisAnchor(db, mvId)) {
      await db.delete(mistake_variant).where(eq(mistake_variant.id, mvId));
    }
    // else: fold-blind pre-event-sourced variant — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedMistakeVariant(db, projected);
}

// Upsert the full row. cause_category is fold-blind, so it comes from the base event.
async function upsertProjectedMistakeVariant(
  db: DbLike,
  projected: MistakeVariantRowSnapshotT,
): Promise<void> {
  const values = pickMistakeVariantFields(projected);
  const { id: _id, ...fields } = values;
  await db.insert(mistake_variant).values(values).onConflictDoUpdate({
    target: mistake_variant.id,
    set: fields,
  });
}
