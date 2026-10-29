// Knowledge relation commands own event provenance, transactional projection and validation.
// Callers must not pair these operations with a second generate/archive event.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { newId as createId } from '@/core/ids';
import { type EdgeTopologyMode, foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import { isDirectTreePair } from '@/core/topology-gate';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

type DbLike = Db | Tx;
type EdgeRow = typeof knowledge_edge.$inferSelect;

/** Called under the edge row lock. Event order must not depend on random IDs. */
async function nextEdgeEventTime(tx: Tx, id: string, requested: Date): Promise<Date> {
  const [latest] = await tx
    .select({ created_at: event.created_at })
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge_edge'), eq(event.subject_id, id)))
    .orderBy(desc(event.created_at))
    .limit(1);
  return new Date(Math.max(requested.getTime(), (latest?.created_at.getTime() ?? -1) + 1));
}

export interface ReactivateKnowledgeEdgeInput {
  weight: number;
  reasoning: string | null;
  actor_kind: string;
  actor_ref: string;
  /** Earliest event time; advanced past existing history when clocks coincide. */
  created_at: Date;
}

/**
 * Revive an archived tombstone whose unique slot a merge rewrite needs. The unique key
 * is global, so a tombstone blocks a fresh insert even with no live duplicate; treating
 * it as a duplicate would silently lose a live relationship. Conflict when the edge is
 * missing or already live.
 */
export async function reactivateKnowledgeEdge(
  db: DbLike,
  id: string,
  input: ReactivateKnowledgeEdgeInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, id))
      .for('update');
    if (!current || current.archived_at === null) {
      throw new ApiError(
        'conflict',
        `reactivateKnowledgeEdge: edge ${id} is not an archived tombstone (live or missing) — refusing to overwrite`,
        409,
      );
    }
    // A revival must sort after its archive even with equal or stale clocks.
    const createdAt = await nextEdgeEventTime(tx, id, input.created_at);
    await writeEvent(tx, {
      id: createId(),
      actor_kind: input.actor_kind,
      actor_ref: input.actor_ref,
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: id,
      outcome: 'success',
      payload: {
        edge_op: 'create',
        from_knowledge_id: current.from_knowledge_id,
        to_knowledge_id: current.to_knowledge_id,
        relation_type: current.relation_type,
        weight: input.weight,
        reasoning: input.reasoning,
      },
      created_at: createdAt,
    });
    // Reviving a tombstone births a NEW live edge, so the ADR-0034 gate applies here
    // even though this is technically a re-fold of recorded history.
    await projectKnowledgeEdgeGuarded(tx, id, { topology: 'enforce' });
  });
}

export interface CreateKnowledgeEdgeInput {
  /** Preserve a caller-owned provenance identity for correction references. */
  generate_event_id?: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight?: number;
  reasoning?: string | null;
  // The actor and proposal identify the generated relation's provenance.
  actor_kind?: string;
  actor_ref?: string;
  propose_event_id?: string;
  // Shared operation timestamp; otherwise captured by this owner.
  created_at?: Date;
}

/**
 * Insert an edge after validating the relation type, live endpoints and tree-pair
 * rule. A duplicate unique key surfaces as 409. Returns the new edge id.
 */
export async function createKnowledgeEdge(
  db: DbLike,
  input: CreateKnowledgeEdgeInput,
): Promise<string> {
  // Revalidate here because callers can bypass the route-layer parse.
  const relationParsed = RelationTypeSchema.safeParse(input.relation_type);
  if (!relationParsed.success) {
    throw new ApiError(
      'validation_error',
      `invalid relation_type: ${relationParsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
    );
  }

  // Domain-friendly 404 before the raw FK error.
  const ids = Array.from(new Set([input.from_knowledge_id, input.to_knowledge_id]));
  const found = await db
    .select({
      id: knowledge.id,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
    })
    .from(knowledge)
    .where(inArray(knowledge.id, ids));
  const foundActive = new Set(found.filter((r) => r.archived_at === null).map((r) => r.id));
  const missing = ids.filter((id) => !foundActive.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      'not_found',
      `unknown or archived knowledge_id(s): ${missing.join(', ')}`,
      404,
    );
  }

  // A mesh edge over a direct parent-child pair would duplicate the tree backbone.
  const repeatsTreeLink = isDirectTreePair(
    input.from_knowledge_id,
    input.to_knowledge_id,
    found.flatMap((node) =>
      node.parent_id ? [{ child_id: node.id, parent_id: node.parent_id }] : [],
    ),
  );
  if (repeatsTreeLink) {
    throw new ApiError(
      'tree_redundancy',
      `mesh edge repeats direct tree relationship: ${input.from_knowledge_id} ↔ ${input.to_knowledge_id}`,
      409,
    );
  }

  const id = createId();
  const createdAt = input.created_at ?? new Date();

  try {
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: input.generate_event_id ?? createId(),
        actor_kind: input.actor_kind ?? 'user',
        actor_ref: input.actor_ref ?? 'self',
        action: 'generate',
        subject_kind: 'knowledge_edge',
        subject_id: id,
        outcome: 'success',
        payload: {
          edge_op: 'create',
          from_knowledge_id: input.from_knowledge_id,
          to_knowledge_id: input.to_knowledge_id,
          relation_type: relationParsed.data,
          weight: input.weight ?? 1,
          reasoning: input.reasoning ?? null,
          ...(input.propose_event_id ? { propose_event_id: input.propose_event_id } : {}),
        },
        caused_by_event_id: input.propose_event_id,
        created_at: createdAt,
      });
      await runEdgeTopologyGate(tx, id, { translateReject: true });
    });
  } catch (err) {
    // Drizzle may expose the pg code on the error or its cause; surface duplicates.
    const pgCode =
      (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') {
      throw new ApiError(
        'conflict',
        `edge already exists: ${input.from_knowledge_id} --${relationParsed.data}--> ${input.to_knowledge_id}`,
        409,
      );
    }
    throw err;
  }

  return id;
}

export interface ArchiveKnowledgeEdgeResult {
  /** The edge id that was targeted. */
  id: string;
  /** true if THIS call flipped archived_at NULL→now; false if it was already archived (idempotent no-op). */
  archived: boolean;
}

export interface EdgeArchiveProvenance {
  event_id?: string;
  caused_by_event_id?: string;
  propose_event_id?: string;
  reasoning?: string | null;
  /** Earliest event time; row-locked sequencing advances past existing history. */
  created_at?: Date;
  /** Internal compensation records must not schedule memory ingestion. */
  ingest_at?: Date;
}

/**
 * One atomic, replayable archive. A concurrent loser returns archived:false without a
 * second event. Historical repair belongs to deployment, not an inline snapshot.
 */
export async function archiveKnowledgeEdgeFromEvents(
  db: DbLike,
  id: string,
  provenance: EdgeArchiveProvenance = {},
): Promise<ArchiveKnowledgeEdgeResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, id))
      .for('update');
    if (!current) throw new ApiError('not_found', `knowledge_edge not found: ${id}`, 404);
    if (current.archived_at !== null) return { id, archived: false };
    const [base] = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.subject_kind, 'knowledge_edge'),
          eq(event.subject_id, id),
          sql`(${event.action} = 'experimental:genesis' OR (${event.action} = 'generate'
        AND (${event.payload}->>'edge_op') IS DISTINCT FROM 'archive'))`,
        ),
      )
      .limit(1);
    if (!base || (await gatherAndFoldKnowledgeEdge(tx, id)) === null) {
      throw new ApiError(
        'conflict',
        `knowledge_edge ${id} requires complete history before archive`,
        409,
      );
    }
    const now = await nextEdgeEventTime(tx, id, provenance.created_at ?? new Date());
    await writeEvent(tx, {
      id: provenance.event_id ?? createId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: id,
      outcome: 'success',
      payload: {
        edge_op: 'archive',
        archive_edge_id: id,
        from_knowledge_id: current.from_knowledge_id,
        to_knowledge_id: current.to_knowledge_id,
        relation_type: current.relation_type,
        reasoning: provenance.reasoning === undefined ? current.reasoning : provenance.reasoning,
        ...(provenance.propose_event_id ? { propose_event_id: provenance.propose_event_id } : {}),
      },
      caused_by_event_id: provenance.caused_by_event_id,
      created_at: now,
      ingest_at: provenance.ingest_at,
    });
    await projectKnowledgeEdgeGuarded(tx, id);
    return { id, archived: true };
  });
}

// Map a live edge row to the snapshot shape the fold produces. Both the mesh and the
// accept-time parity assert use this one mapper, so their shapes cannot drift.
export function edgeRowToSnapshot(row: EdgeRow): KnowledgeEdgeRowSnapshotT {
  return {
    id: row.id,
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type,
    weight: row.weight,
    created_by: row.created_by as Record<string, unknown>,
    reasoning: row.reasoning ?? null,
    created_at: row.created_at,
    archived_at: row.archived_at ?? null,
  };
}

/**
 * Gather the events for `edgeId` and run the pure edge fold against a caller-supplied
 * live mesh. A batch caller fetches the mesh once, avoiding an O(E²) rescan. The mesh
 * includes the edge itself when live, which the topology check treats as already present.
 */
export async function gatherAndFoldKnowledgeEdgeWithMesh(
  db: DbLike,
  edgeId: string,
  liveMesh: KnowledgeEdgeRowSnapshotT[],
  opts?: { topology?: EdgeTopologyMode },
): Promise<KnowledgeEdgeRowSnapshotT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge_edge'), eq(event.subject_id, edgeId)));
  const foldEvents = rows.map(rowToFoldEvent);
  return foldKnowledgeEdge(edgeId, foldEvents, liveMesh, opts);
}

/**
 * Single-edge form: fetch the live mesh, then delegate. A topology reject in write
 * mode propagates so the caller decides whether to abort.
 */
export async function gatherAndFoldKnowledgeEdge(
  db: DbLike,
  edgeId: string,
  opts?: { topology?: EdgeTopologyMode },
): Promise<KnowledgeEdgeRowSnapshotT | null> {
  const liveRows = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
  const liveMesh = liveRows.map(edgeRowToSnapshot);
  return gatherAndFoldKnowledgeEdgeWithMesh(db, edgeId, liveMesh, opts);
}

// created_by type comes from the table's inferred shape, avoiding a cross-import of the alias.
type EdgeCreatedBy = EdgeRow['created_by'];

/**
 * Re-project one `knowledge_edge`. A fold of null deletes the row; otherwise upsert.
 * A write-mode topology reject propagates so the caller's transaction aborts.
 */
export async function projectKnowledgeEdge(
  db: DbLike,
  edgeId: string,
  opts?: { topology?: EdgeTopologyMode },
): Promise<void> {
  const projected = await gatherAndFoldKnowledgeEdge(db, edgeId, opts);

  if (projected === null) {
    await db.delete(knowledge_edge).where(eq(knowledge_edge.id, edgeId));
    return;
  }
  await upsertProjectedKnowledgeEdge(db, projected);
}

/**
 * Guarded write-through: an edge folds to null only without a create event, which means
 * a legacy row the fold cannot see, so this variant never deletes.
 */
export async function projectKnowledgeEdgeGuarded(
  db: DbLike,
  edgeId: string,
  opts?: { topology?: EdgeTopologyMode },
): Promise<void> {
  const projected = await gatherAndFoldKnowledgeEdge(db, edgeId, opts);
  if (projected === null) {
    return;
  }
  await upsertProjectedKnowledgeEdge(db, projected);
}

// Upsert the full row; the table has no version or embed_* columns.
async function upsertProjectedKnowledgeEdge(
  db: DbLike,
  projected: KnowledgeEdgeRowSnapshotT,
): Promise<void> {
  if (projected.archived_at === null) {
    const endpointRows = await db
      .select({ id: knowledge.id, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(inArray(knowledge.id, [projected.from_knowledge_id, projected.to_knowledge_id]));
    if (
      isDirectTreePair(
        projected.from_knowledge_id,
        projected.to_knowledge_id,
        endpointRows.flatMap((node) =>
          node.parent_id ? [{ child_id: node.id, parent_id: node.parent_id }] : [],
        ),
      )
    ) {
      throw new Error(
        `projectKnowledgeEdge: tree redundancy for ${projected.from_knowledge_id} ↔ ${projected.to_knowledge_id}`,
      );
    }
  }

  await db
    .insert(knowledge_edge)
    .values({
      id: projected.id,
      from_knowledge_id: projected.from_knowledge_id,
      to_knowledge_id: projected.to_knowledge_id,
      relation_type: projected.relation_type,
      weight: projected.weight,
      created_by: projected.created_by as unknown as EdgeCreatedBy,
      reasoning: projected.reasoning,
      created_at: projected.created_at,
      archived_at: projected.archived_at,
    })
    .onConflictDoUpdate({
      target: knowledge_edge.id,
      set: {
        from_knowledge_id: projected.from_knowledge_id,
        to_knowledge_id: projected.to_knowledge_id,
        relation_type: projected.relation_type,
        weight: projected.weight,
        created_by: projected.created_by as unknown as EdgeCreatedBy,
        reasoning: projected.reasoning,
        created_at: projected.created_at,
        archived_at: projected.archived_at,
      },
    });
}

/**
 * Translate the fold's topology reject into a 409. Match the inner message, because the
 * parity assert may re-wrap it. Any other error returns null and is rethrown unchanged.
 */
function foldRejectToApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return null;
  const message = err instanceof Error ? err.message : String(err);
  const match = /ADR-0034 topology reject on edge \S+ \(gate=([a-z_]+)\): ([\s\S]*)/.exec(message);
  if (!match) return null;
  const gate = match[1];
  const reason = match[2].trim();
  return new ApiError(
    gate,
    `knowledge_edge write rejected by ADR-0034 topology gate (${gate}): ${reason}`,
    409,
  );
}

/**
 * Materialize the accepted event and enforce topology in the same transaction. A reject
 * always aborts; `translateReject` maps it to a clean ApiError for direct routes. This
 * is the write throat — the only fold path that runs the gate in 'enforce' mode.
 */
export async function runEdgeTopologyGate(
  tx: Tx,
  edgeId: string,
  opts?: { translateReject?: boolean },
): Promise<void> {
  try {
    await projectKnowledgeEdgeGuarded(tx, edgeId, { topology: 'enforce' });
  } catch (err) {
    if (opts?.translateReject) {
      const apiErr = foldRejectToApiError(err);
      if (apiErr) throw apiErr;
    }
    throw err;
  }
}
