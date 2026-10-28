// Shared read-only history, structural snapshot and anchor facts for knowledge nodes.
// Live materialization, parity and full-table replay use the same node event set.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';
import { getAnchorEventId } from './materialized-id-index';
import { rowToFoldEvent } from './projection-events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

/**
 * Prefetch the node-independent merge leg, grouped by absorbed node id. A full-table
 * caller folds many nodes, so grouping once avoids rescanning every merge per node.
 */
export async function prefetchKnowledgeMergeEvents(db: DbLike): Promise<Map<string, EventRow[]>> {
  const merges = await db
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:knowledge_merge'));
  // Index each merge under every from_id it archives (mirrors `payload -> 'from_ids' @> [nodeId]`:
  // absent/non-array/non-string from_ids index under no node, as `@>` returning NULL yields no match).
  const byFromId = new Map<string, EventRow[]>();
  for (const m of merges) {
    const fromIds = (m.payload as { from_ids?: unknown } | null)?.from_ids;
    if (!Array.isArray(fromIds)) continue;
    for (const fid of fromIds) {
      if (typeof fid !== 'string') continue;
      const list = byFromId.get(fid);
      if (list) list.push(m);
      else byFromId.set(fid, [m]);
    }
  }
  return byFromId;
}

/**
 * Prefetch knowledge-scoped rate events, grouped by the event they accept. The inner
 * join keeps only rates accepting a knowledge event, so a full-table fold does not load
 * every rate in the system.
 */
export async function prefetchKnowledgeRates(db: DbLike): Promise<Map<string, EventRow[]>> {
  const accepted = alias(event, 'accepted_event');
  const rows = await db
    .select()
    .from(event)
    .innerJoin(accepted, eq(event.caused_by_event_id, accepted.id))
    .where(and(eq(event.action, 'rate'), eq(accepted.subject_kind, 'knowledge')));
  const byCausedBy = new Map<string, EventRow[]>();
  for (const { event: r } of rows) {
    const cb = r.caused_by_event_id;
    if (cb === null) continue; // (join already excludes these; belt-and-suspenders for the map key)
    const list = byCausedBy.get(cb);
    if (list) list.push(r);
    else byCausedBy.set(cb, [r]);
  }
  return byCausedBy;
}

/**
 * Gather the events affecting `nodeId` and run the pure node fold. The gather combines
 * subject-keyed events, the reverse-index anchor for propose_new/split, a merge
 * containment scan, and the chained accept rates. Returns the projected row or null.
 */
export async function gatherAndFoldKnowledgeNode(
  db: DbLike,
  nodeId: string,
  prefetchedMergeEvents?: Map<string, EventRow[]>,
  prefetchedRates?: Map<string, EventRow[]>,
): Promise<KnowledgeRowSnapshotT | null> {
  // Q1: events whose subject_id is nodeId.
  // Covers genesis, auto_tag, reparent, archive, merge-as-into, and split-as-from.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge'), eq(event.subject_id, nodeId)));

  // Q2: nodes born via propose_new/split have no event keyed on their own id. Their anchor
  // is the event the accept materialized them from; pull it plus everything caused by it.
  const anchorId = await getAnchorEventId(db, nodeId);
  const q2: EventRow[] = anchorId
    ? await db
        .select()
        .from(event)
        .where(or(eq(event.id, anchorId), eq(event.caused_by_event_id, anchorId)))
    : [];

  // Q3: a node merged into another appears only in the merge event's payload.from_ids.
  const q3 = prefetchedMergeEvents
    ? (prefetchedMergeEvents.get(nodeId) ?? [])
    : await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:knowledge_merge'),
            sql`${event.payload} -> 'from_ids' @> ${JSON.stringify([nodeId])}::jsonb`,
          ),
        );

  // Dedup the gathered rows by event id; the legs overlap.
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2, ...q3]) byId.set(r.id, r);

  // Rate resolution: the reducer needs the accept rates chained to the gathered events.
  const gatheredIds = [...byId.keys()];
  if (gatheredIds.length > 0) {
    if (prefetchedRates) {
      for (const gid of gatheredIds) {
        const chained = prefetchedRates.get(gid);
        if (!chained) continue;
        // Re-check the action so a future, wider prefetch set cannot absorb a non-rate event.
        for (const r of chained) if (r.action === 'rate') byId.set(r.id, r);
      }
    } else {
      const rates = await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, gatheredIds)));
      for (const r of rates) byId.set(r.id, r);
    }
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldKnowledgeNode(nodeId, foldEvents);
}

/**
 * Pick the snapshot fields from a live row without Zod parsing: a parse throw could abort
 * a live accept, and a plain pick cannot throw.
 */
export function knowledgeLiveRowToSnapshot(row: {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  merged_from: string[];
  archived_at: Date | null;
  proposed_by_ai: boolean;
  approval_status: 'pending' | 'approved' | 'rejected';
  role?: 'kc' | 'goal' | 'container';
  created_at: Date;
  updated_at: Date;
  version: number;
}): KnowledgeRowSnapshotT {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    parent_id: row.parent_id,
    merged_from: row.merged_from,
    archived_at: row.archived_at,
    proposed_by_ai: row.proposed_by_ai,
    approval_status: row.approval_status,
    // YUK-1600 — identity role; optional so pre-column callers keep compiling, and the
    // fold's always-defined default makes parity treat absent-as-'kc' on both sides.
    role: row.role ?? 'kc',
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * Whether a node is event-sourced: a genesis/auto-tag event or an index anchor.
 * Pre-event rows fold to null, so callers gate the assert on this to avoid false mismatches.
 */
export async function hasKnowledgeNodeGenesisAnchor(db: DbLike, nodeId: string): Promise<boolean> {
  const genesisOrAutoTag = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'knowledge'),
        eq(event.subject_id, nodeId),
        or(
          eq(event.action, 'experimental:genesis'),
          eq(event.action, 'experimental:auto_tag_kc_created'),
        ),
      ),
    )
    .limit(1);
  if (genesisOrAutoTag.length > 0) return true;

  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, nodeId),
        // genesis anchor for a NODE — materialized_id_index also carries edge anchors, so
        // constrain by subject_kind to never read an edge anchor as a node's genesis anchor.
        eq(materialized_id_index.subject_kind, 'knowledge'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/**
 * Batch form of hasKnowledgeNodeGenesisAnchor; one query per source.
 */
export async function knowledgeNodesWithGenesisAnchor(
  db: DbLike,
  nodeIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (nodeIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'knowledge'),
        inArray(event.subject_id, nodeIds),
        or(
          eq(event.action, 'experimental:genesis'),
          eq(event.action, 'experimental:auto_tag_kc_created'),
        ),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, nodeIds),
        // NODE anchors only — see hasKnowledgeNodeGenesisAnchor (edge anchors share the table).
        eq(materialized_id_index.subject_kind, 'knowledge'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}
