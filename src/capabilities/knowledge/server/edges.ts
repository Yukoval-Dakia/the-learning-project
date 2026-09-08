// Knowledge relation commands own event provenance, transactional projection and validation.
// Callers must not pair these operations with a second generate/archive event.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { RelationTypeSchema, type RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { gatherAndFoldKnowledgeEdge } from '@/server/projections/gather';
import { projectKnowledgeEdgeGuarded } from '@/server/projections/knowledge_edge';
import { runEdgeTopologyGate } from './edge-topology-write';
import { isDirectTreePair } from './topology-gate';

type DbLike = Db | Tx;

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

// ---------- Types ----------

export interface KnowledgeEdgeRow {
  id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: RelationTypeSchemaT;
  weight: number;
  created_by: unknown;
  reasoning: string | null;
  created_at: Date;
  archived_at: Date | null;
}

// ---------- List ----------

export interface ListKnowledgeEdgesFilter {
  subject?: string;
  from?: string;
  to?: string;
  relation_type?: string;
  /** Include soft-deleted edges (archived_at NOT NULL). Default: false. */
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

const LIST_LIMIT = 500;

interface KnowledgeEdgeCursor {
  createdAt: Date;
  id: string;
}

function encodeKnowledgeEdgeCursor(row: typeof knowledge_edge.$inferSelect): string {
  return Buffer.from(
    JSON.stringify({ created_at: row.created_at.toISOString(), id: row.id }),
  ).toString('base64url');
}

function decodeKnowledgeEdgeCursor(cursor: string): KnowledgeEdgeCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      created_at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('missing created_at or id');
    }
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid created_at');
    return { createdAt, id: parsed.id };
  } catch (err) {
    throw new ApiError(
      'invalid_cursor',
      `invalid knowledge edge cursor: ${(err as Error).message}`,
      400,
    );
  }
}

function projectKnowledgeEdge(row: typeof knowledge_edge.$inferSelect): KnowledgeEdgeRow {
  return {
    id: row.id,
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type as RelationTypeSchemaT,
    weight: row.weight,
    created_by: row.created_by,
    reasoning: row.reasoning,
    created_at: row.created_at,
    archived_at: row.archived_at,
  };
}

export interface KnowledgeEdgePage {
  rows: KnowledgeEdgeRow[];
  next_cursor: string | null;
}

export async function listKnowledgeEdgesPage(
  db: DbLike,
  filter: ListKnowledgeEdgesFilter = {},
): Promise<KnowledgeEdgePage> {
  const limit = Math.min(Math.max(filter.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
  const cursor = filter.cursor ? decodeKnowledgeEdgeCursor(filter.cursor) : null;
  const conditions = [];
  if (filter.from) conditions.push(eq(knowledge_edge.from_knowledge_id, filter.from));
  if (filter.to) conditions.push(eq(knowledge_edge.to_knowledge_id, filter.to));
  if (filter.relation_type) conditions.push(eq(knowledge_edge.relation_type, filter.relation_type));
  if (filter.subject) {
    const subjectKnowledgeIds = await resolveSubjectKnowledgeIds(db, filter.subject);
    conditions.push(
      subjectKnowledgeIds.length > 0
        ? or(
            inArray(knowledge_edge.from_knowledge_id, subjectKnowledgeIds),
            inArray(knowledge_edge.to_knowledge_id, subjectKnowledgeIds),
          )
        : sql`false`,
    );
  }
  if (!filter.includeArchived) conditions.push(isNull(knowledge_edge.archived_at));
  if (cursor) {
    conditions.push(
      or(
        lt(knowledge_edge.created_at, cursor.createdAt),
        and(eq(knowledge_edge.created_at, cursor.createdAt), lt(knowledge_edge.id, cursor.id)),
      ) as NonNullable<ReturnType<typeof or>>,
    );
  }

  const baseQuery = db.select().from(knowledge_edge);
  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const fetched = await filtered
    .orderBy(desc(knowledge_edge.created_at), desc(knowledge_edge.id))
    .limit(limit + 1);
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const last = rows.at(-1);
  return {
    rows: rows.map(projectKnowledgeEdge),
    next_cursor: hasMore && last ? encodeKnowledgeEdgeCursor(last) : null,
  };
}

export async function listKnowledgeEdges(
  db: DbLike,
  filter: ListKnowledgeEdgesFilter = {},
): Promise<KnowledgeEdgeRow[]> {
  return (await listKnowledgeEdgesPage(db, filter)).rows;
}

/**
 * YUK-543 — list the LIVE (archived_at IS NULL) edges that touch `nodeId` on EITHER endpoint
 * (from_knowledge_id = nodeId OR to_knowledge_id = nodeId). Used by the merge-driven edge rewire
 * (rewireKnowledgeEdges) to find every edge whose endpoint must be re-pointed at the merge survivor.
 * READ-ONLY. No LIST_LIMIT — a merge must rewire ALL of a KC's edges, never a truncated subset.
 */
export async function listLiveEdgesTouchingNode(
  db: DbLike,
  nodeId: string,
): Promise<KnowledgeEdgeRow[]> {
  const rows = await db
    .select()
    .from(knowledge_edge)
    .where(
      and(
        isNull(knowledge_edge.archived_at),
        or(
          eq(knowledge_edge.from_knowledge_id, nodeId),
          eq(knowledge_edge.to_knowledge_id, nodeId),
        ),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    from_knowledge_id: r.from_knowledge_id,
    to_knowledge_id: r.to_knowledge_id,
    relation_type: r.relation_type as RelationTypeSchemaT,
    weight: r.weight,
    created_by: r.created_by,
    reasoning: r.reasoning,
    created_at: r.created_at,
    archived_at: r.archived_at,
  }));
}

/** The minimal endpoint triple the ADR-0034 topology gate consumes. */
export interface LivePrerequisiteEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

/**
 * YUK-543 (review R1) — the FULL live prerequisite mesh, UNBOUNDED. READ-ONLY.
 *
 * MUST have no LIST_LIMIT: cycle / direction-contradiction detection (checkEdgeTopology) is only
 * sound against the COMPLETE live prerequisite edge set. `listKnowledgeEdges` truncates at
 * LIST_LIMIT=500 ordered created_at DESC — beyond 500 live prerequisite edges the OLDEST (backbone)
 * edges silently fall out of the mesh, and a rewrite that closes a cycle through a truncated edge
 * gets a false 'ok' verdict instead of the reject-abort it must produce. Same doctrine as
 * `listLiveEdgesTouchingNode` above and the bare unbounded scan `runEdgeProposeAndWrite` uses for
 * its own topology mesh (propose_edge.ts).
 */
export async function listAllLivePrerequisiteEdges(db: DbLike): Promise<LivePrerequisiteEdge[]> {
  return await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
    })
    .from(knowledge_edge)
    .where(
      and(isNull(knowledge_edge.archived_at), eq(knowledge_edge.relation_type, 'prerequisite')),
    );
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
 * YUK-543 (review R2) — un-archive a tombstone edge whose UNIQUE(from,to,relation_type) slot a
 * merge rewrite needs. `knowledge_edge_unique` is GLOBAL (no partial WHERE archived_at IS NULL), so
 * an archived tombstone blocks a fresh INSERT with 23505 even though no LIVE duplicate exists —
 * blind archive-as-duplicate there would silently evaporate a live relationship. Instead the
 * tombstone is revived in place.
 *
 * Records the complete reactivation event and projects it under the tombstone row lock.
 * Concurrent attempts cannot overwrite a newly live row; failure rolls back the event.
 *
 * @throws ApiError('conflict', 409) when `id` does not exist or is not currently archived.
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
    // Replays sort by timestamp then opaque ID. A revival must follow its archive
    // even when two commands share a millisecond or the supplied clock is stale.
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
    await projectKnowledgeEdgeGuarded(tx, id);
  });
}

export async function getKnowledgeEdgeById(
  db: DbLike,
  id: string,
): Promise<KnowledgeEdgeRow | null> {
  const rows = await db.select().from(knowledge_edge).where(eq(knowledge_edge.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    from_knowledge_id: r.from_knowledge_id,
    to_knowledge_id: r.to_knowledge_id,
    relation_type: r.relation_type as RelationTypeSchemaT,
    weight: r.weight,
    created_by: r.created_by,
    reasoning: r.reasoning,
    created_at: r.created_at,
    archived_at: r.archived_at,
  };
}

// ---------- Create ----------

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
 * Insert a knowledge_edge with Zod validation on `relation_type` (must be one
 * of 5 core enums or `experimental:*` per ADR-0010), active-endpoint and direct
 * tree-pair checks, and UNIQUE(from, to, relation_type) violation surfacing as
 * ApiError('conflict', 409).
 *
 * @returns the new edge id (assigned here unless caller pre-computes one).
 */
export async function createKnowledgeEdge(
  db: DbLike,
  input: CreateKnowledgeEdgeInput,
): Promise<string> {
  // 1) Validate relation_type via Lane B schema. Throws ZodError on miss;
  //    callers (routes) translate to ApiError('validation_error', 400) via
  //    safeParse on the request body upstream — here we re-validate in case
  //    callers bypass the route-layer parse.
  const relationParsed = RelationTypeSchema.safeParse(input.relation_type);
  if (!relationParsed.success) {
    throw new ApiError(
      'validation_error',
      `invalid relation_type: ${relationParsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
    );
  }

  // 3) FK existence: both endpoints must point at non-archived knowledge nodes.
  //    Drizzle's `.references()` only declares FK at DDL; here we surface a
  //    domain-friendly 404 before hitting the DB constraint (and avoid the
  //    raw pg error code 23503 in errorResponse).
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

  // ADR-0011 / YUK-674 — tree is the structural backbone; a mesh edge over a
  // direct child↔parent pair would represent and weight the same relationship a
  // second time. Enforce this at the single INSERT owner so CRUD, proposal accept,
  // supersede and merge-rewire callers cannot bypass the invariant.
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
    // Drizzle wraps the raw postgres-js error in its own Error. The original pg
    // error code (`23505` = unique_violation per ADR-0010 UNIQUE(from, to,
    // relation_type)) lives on `.cause.code` and is also re-surfaced on `.code`
    // by some Drizzle versions; check both. We catch raw vs
    // `.onConflictDoNothing()` so concurrent dup creates surface clearly (409)
    // rather than silently dropping the second write.
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

// ---------- Archive (soft-delete) ----------

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

/** Own one atomic, replayable archive. Existing caller transactions become savepoints.
 * A concurrent loser returns archived:false without publishing a second event.
 * Historical repair belongs to deployment, never a silent inline snapshot.
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
