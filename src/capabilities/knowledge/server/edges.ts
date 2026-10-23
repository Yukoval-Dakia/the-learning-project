// Knowledge relation commands own event provenance, transactional projection and validation.
// Callers must not pair these operations with a second generate/archive event.

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';

export type {
  ArchiveKnowledgeEdgeResult,
  CreateKnowledgeEdgeInput,
  EdgeArchiveProvenance,
  ReactivateKnowledgeEdgeInput,
} from '@/kernel/records/knowledge-edge-facts';
export {
  archiveKnowledgeEdgeFromEvents,
  createKnowledgeEdge,
  reactivateKnowledgeEdge,
} from '@/kernel/records/knowledge-edge-facts';

type DbLike = Db | Tx;

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
 * Live edges touching either endpoint. Unbounded: a merge must rewire all of a KC's
 * edges, never a truncated subset.
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
 * The complete live prerequisite mesh. It must stay unbounded: a truncated mesh makes
 * cycle and direction checks unsound, because a cycle through a dropped edge would pass.
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
