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
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { RelationTypeSchema, type RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

type DbLike = Db | Tx;

// ---------- Types ----------

const AgentRefLike = z.union([z.literal('user'), z.string().min(1)]);

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
  created_by?: unknown;
  reasoning?: string | null;
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

  // 2) created_by defaults to 'user' (single-user assumption per ADR-0007);
  //    AgentRef shape passes through unchanged for AI-generated edges.
  //    Codex P2-H: convert ZodError to ApiError(400) so callers get a clean
  //    `validation_error` response instead of a raw 500.
  const createdBy = input.created_by ?? 'user';
  const createdByParsed = AgentRefLike.safeParse(createdBy);
  if (!createdByParsed.success) {
    throw new ApiError(
      'validation_error',
      `invalid created_by: ${createdByParsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
    );
  }

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
  const now = new Date();

  try {
    await db.insert(knowledge_edge).values({
      id,
      from_knowledge_id: input.from_knowledge_id,
      to_knowledge_id: input.to_knowledge_id,
      relation_type: relationParsed.data,
      weight: input.weight ?? 1,
      created_by: createdBy as never,
      reasoning: input.reasoning ?? null,
      created_at: now,
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

// suppress unused-import warning at module level
void sql;
