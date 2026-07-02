// Phase 1c.1 Step 6 — knowledge_edge single-owner module (ADR-0005 extended to
// edges per ADR-0010). All INSERTs into `knowledge_edge` go through this module.
//
// Read API:
//   - listKnowledgeEdges(db, filter?) — filter by from / to / relation_type
//   - getKnowledgeEdgeById(db, id) — single edge lookup
//
// Write API:
//   - createKnowledgeEdge(db, input) — INSERT with FK + Zod validation;
//     UNIQUE(from, to, relation_type) violation surfaces as ApiError('conflict', 409)
//
// Mirrors `src/server/session/` style: per-module single-owner, callers import
// named fns; raw `db.insert(knowledge_edge)` outside this module is forbidden.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { RelationTypeSchema, type RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

type DbLike = Db | Tx;

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
  from?: string;
  to?: string;
  relation_type?: string;
  /** Include soft-deleted edges (archived_at NOT NULL). Default: false. */
  includeArchived?: boolean;
}

const LIST_LIMIT = 500;

export async function listKnowledgeEdges(
  db: DbLike,
  filter: ListKnowledgeEdgesFilter = {},
): Promise<KnowledgeEdgeRow[]> {
  const conditions = [];
  if (filter.from) conditions.push(eq(knowledge_edge.from_knowledge_id, filter.from));
  if (filter.to) conditions.push(eq(knowledge_edge.to_knowledge_id, filter.to));
  if (filter.relation_type) conditions.push(eq(knowledge_edge.relation_type, filter.relation_type));
  if (!filter.includeArchived) conditions.push(isNull(knowledge_edge.archived_at));

  const baseQuery = db.select().from(knowledge_edge);
  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const rows = await filtered.orderBy(desc(knowledge_edge.created_at)).limit(LIST_LIMIT);

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
  /** MUST equal the paired generate(create) event's created_at (the fold stamps the row from it). */
  created_at: Date;
}

/**
 * YUK-543 (review R2) — un-archive a tombstone edge whose UNIQUE(from,to,relation_type) slot a
 * merge rewrite needs. `knowledge_edge_unique` is GLOBAL (no partial WHERE archived_at IS NULL), so
 * an archived tombstone blocks a fresh INSERT with 23505 even though no LIVE duplicate exists —
 * blind archive-as-duplicate there would silently evaporate a live relationship. Instead the
 * tombstone is revived in place.
 *
 * FOLD CONTRACT: the caller MUST write a paired `generate`(create) event anchored to THIS edge id
 * with the SAME actor/weight/reasoning/created_at. The edge fold replays create events in order —
 * the new (last) create re-projects this row as live with created_at/created_by/weight/reasoning
 * taken from that event — so this UPDATE refreshes those columns to byte-match the fold output
 * (row == fold, the B3 audit invariant). Single-owner: all knowledge_edge writes stay in this module.
 */
export async function reactivateKnowledgeEdge(
  db: DbLike,
  id: string,
  input: ReactivateKnowledgeEdgeInput,
): Promise<void> {
  await db
    .update(knowledge_edge)
    .set({
      archived_at: null,
      weight: input.weight,
      reasoning: input.reasoning,
      created_by: { actor_kind: input.actor_kind, actor_ref: input.actor_ref } as never,
      created_at: input.created_at,
    })
    .where(eq(knowledge_edge.id, id));
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
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight?: number;
  reasoning?: string | null;
  // YUK-471 — created_by is stored as the {actor_kind, actor_ref(, propose_event_id)} shape the
  // edge FOLD reconstructs (src/core/projections/knowledge_edge.ts rowFromGenerateEvent), NOT a
  // bare string, so a createKnowledgeEdge-created edge folds == its row (the projection SoT). The
  // caller MUST write a `generate`(create) event with the SAME actor_kind/actor_ref + this created_at.
  // Default {user, self} (the manual-user case). A caller that ALSO writes a generate event MUST
  // pass the matching actor (POST=user/self, reconcile=agent/dreaming) or the fold won't reproduce.
  actor_kind?: string;
  actor_ref?: string;
  propose_event_id?: string;
  // created_at must equal the caller's generate event's created_at — the fold takes the row's
  // created_at FROM that event. Defaults to now() only for a caller with no paired event.
  created_at?: Date;
}

/**
 * Insert a knowledge_edge with Zod validation on `relation_type` (must be one
 * of 5 core enums or `experimental:*` per ADR-0010), FK existence check on
 * both endpoints, and UNIQUE(from, to, relation_type) violation surfacing as
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

  // 2) created_by — the edge FOLD's {actor_kind, actor_ref(, propose_event_id)} shape (see the
  //    input doc). Built from the explicit actor fields so every createKnowledgeEdge edge stores
  //    the EXACT shape the fold reconstructs → fold(events) == row. (Previously stored a bare
  //    string default 'user', which the fold could never reproduce — YUK-471 BYPASS-2 fix.)
  const createdBy: Record<string, string> = {
    actor_kind: input.actor_kind ?? 'user',
    actor_ref: input.actor_ref ?? 'self',
    ...(input.propose_event_id ? { propose_event_id: input.propose_event_id } : {}),
  };

  // 3) FK existence: both endpoints must point at non-archived knowledge nodes.
  //    Drizzle's `.references()` only declares FK at DDL; here we surface a
  //    domain-friendly 404 before hitting the DB constraint (and avoid the
  //    raw pg error code 23503 in errorResponse).
  const ids = Array.from(new Set([input.from_knowledge_id, input.to_knowledge_id]));
  const found = await db
    .select({ id: knowledge.id, archived_at: knowledge.archived_at })
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

  const id = createId();
  const createdAt = input.created_at ?? new Date();

  try {
    await db.insert(knowledge_edge).values({
      id,
      from_knowledge_id: input.from_knowledge_id,
      to_knowledge_id: input.to_knowledge_id,
      relation_type: relationParsed.data,
      weight: input.weight ?? 1,
      created_by: createdBy as never,
      reasoning: input.reasoning ?? null,
      created_at: createdAt,
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

/**
 * ADR-0032 D4-E1 (YUK-203) — soft-delete one knowledge_edge by setting
 * `archived_at` (never a hard DELETE — 守「写入仅 propose + correction 可回滚」
 * 不变量；read APIs already filter `isNull(archived_at)` so an archived edge
 * disappears from the live mesh but the row + its provenance survive for retract).
 *
 * Idempotent: the UPDATE is guarded on `isNull(archived_at)`, so re-archiving an
 * already-archived edge changes zero rows and returns `{ archived: false }` rather
 * than erroring — the accept path can be retried safely (the proposal-accept
 * idempotency above this layer relies on this).
 *
 * @throws ApiError('not_found', 404) when no edge with `id` exists at all.
 */
export async function archiveKnowledgeEdge(
  db: DbLike,
  id: string,
  // YUK-471 W1 PR-B — stamp archived_at from the caller's accept-time `now` so it matches the
  // generate-archive event's created_at (fold == row for an archived edge). Without this the
  // projection's archived_at, derived from the event, diverges from the imperative one by a few
  // ms, and the B3 audit would flag every archived edge as drift. Defaults to new Date() for the
  // other callers that don't thread an accept-time instant.
  now: Date = new Date(),
): Promise<ArchiveKnowledgeEdgeResult> {
  const existing = await db
    .select({ id: knowledge_edge.id, archived_at: knowledge_edge.archived_at })
    .from(knowledge_edge)
    .where(eq(knowledge_edge.id, id))
    .limit(1);
  const row = existing[0];
  if (!row) {
    throw new ApiError('not_found', `knowledge_edge not found: ${id}`, 404);
  }
  if (row.archived_at !== null) {
    // Already archived — idempotent no-op (a re-accept of the same archive
    // proposal lands here).
    return { id, archived: false };
  }

  await db
    .update(knowledge_edge)
    .set({ archived_at: now })
    .where(and(eq(knowledge_edge.id, id), isNull(knowledge_edge.archived_at)));

  return { id, archived: true };
}

// suppress unused-import warning at module level
void sql;
