import { and, inArray, isNull, or } from 'drizzle-orm';
import { TaggingTaskError, parseTaggingOutput } from '@/capabilities/ingestion/tasks/tagging';
import { EMBED_VERSION, questionEmbedText } from '@/core/embed-source';
/**
 * TaggingTask invoker: a single-shot, text-only structured task over a knowledge
 * grid snapshot. The grid is relevance-ranked when the candidate set exceeds the
 * prompt budget; suggestions are checked for existence in the knowledge library,
 * not for membership in the truncated grid. The runner and embedder are injectable.
 */
import {
  TaggingInput as TaggingInputSchema,
  type TaggingInputT,
  type TaggingOutputT,
} from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { isEmbedRevisionCurrent } from '@/db/embed-currency';
import { knowledge, knowledge_edge } from '@/db/schema';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { createKnowledgeTagEmbedder } from './knowledge-namer';
import { redactIngestionText } from './privacy-guard';

/**
 * Thrown when the TaggingTask cannot produce a usable result (provider down,
 * unparseable output). Callers (auto-enroll) treat this as "route to review" —
 * a tagging outage must never auto-enroll, only ever fall back to human review.
 */
export { TaggingTaskError };

export type TaggingRunTaskFn = (
  kind: string,
  input: TaggingInputT,
  ctx: unknown,
) => Promise<{ text: string }>;

/** The embedder seam used only when the candidate grid needs relevance ranking. */
export interface TaggingGridEmbedder {
  embed(text: string): Promise<number[]>;
}

export interface RunTaggingTaskParams {
  db: Db;
  /** Extracted question text (derive via structuredToPromptMarkdown upstream). */
  questionMd: string;
  /** Soft hint from extraction (question_block.knowledge_hint), or null. */
  knowledgeHint: string | null;
  /**
   * Restrict the candidate grid to one subject domain. When omitted, all active
   * knowledge nodes are candidates (single-subject Phase 1 default).
   */
  subjectId?: string;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: TaggingRunTaskFn;
  /** Inject in tests; defaults to the production knowledge-tag embedder. */
  embedder?: TaggingGridEmbedder;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

export interface TaggingRunResult extends TaggingOutputT {
  /**
   * True when the subject's active node set exceeded MAX_GRID_NODES and the prompt
   * grid carries only the relevance-ranked head. Suggestions for real KCs outside
   * the grid are still kept by the existence check below.
   */
  grid_truncated: boolean;
}

const MAX_GRID_NODES = 200;

type KnowledgeRow = {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
};

type KnowledgeVectorRow = {
  id: string;
  version: number;
  embed_version: number | null;
  embed_source_revision: number | null;
  embedding: number[] | null;
};

function buildPath(id: string, byId: Map<string, KnowledgeRow>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

/** Loads active knowledge nodes (optionally scoped to one effective domain). */
async function loadGridNodes(db: Db, subjectId?: string): Promise<KnowledgeRow[]> {
  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  if (!subjectId) return rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const effectiveDomain = (row: KnowledgeRow): string | null => {
    let current: KnowledgeRow | undefined = row;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.domain) return current.domain;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return null;
  };
  return rows.filter((row) => effectiveDomain(row) === subjectId);
}

/** Vectors are loaded only when the candidate set needs relevance ranking. */
async function loadGridVectors(db: Db, ids: string[]): Promise<Map<string, KnowledgeVectorRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: knowledge.id,
      version: knowledge.version,
      embed_version: knowledge.embed_version,
      embed_source_revision: knowledge.embed_source_revision,
      embedding: knowledge.embedding,
    })
    .from(knowledge)
    .where(inArray(knowledge.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadGridEdges(
  db: Db,
  ids: string[],
): Promise<Array<{ from_knowledge_id: string; to_knowledge_id: string; relation_type: string }>> {
  if (ids.length === 0) return [];
  const idCondition = or(
    inArray(knowledge_edge.from_knowledge_id, ids),
    inArray(knowledge_edge.to_knowledge_id, ids),
  );
  const conditions = [isNull(knowledge_edge.archived_at)];
  if (idCondition) conditions.push(idCondition);
  return await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
    })
    .from(knowledge_edge)
    .where(and(...conditions));
}

/** pgvector cosine distance: 0 nearest, 2 farthest. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aNorm += x * x;
    bNorm += y * y;
  }
  if (aNorm === 0 || bNorm === 0) return 2;
  return 1 - dot / Math.sqrt(aNorm * bNorm);
}

/**
 * Nearest-first by question embedding. Unembedded or revision-stale vectors have
 * no usable relevance and sort last; ties fall back to the hierarchy path so the
 * grid order is deterministic.
 */
function rankKnowledgeRows(
  rows: KnowledgeRow[],
  vectors: Map<string, KnowledgeVectorRow>,
  queryEmbedding: number[],
  byId: Map<string, KnowledgeRow>,
): KnowledgeRow[] {
  const distances = new Map<string, number>();
  for (const row of rows) {
    const vectorRow = vectors.get(row.id);
    const vector = vectorRow?.embedding ?? null;
    if (vectorRow === undefined || vector === null || vector.length === 0) continue;
    if (vectorRow.embed_version !== EMBED_VERSION || !isEmbedRevisionCurrent(vectorRow)) {
      continue;
    }
    if (vector.length !== queryEmbedding.length) {
      throw new TaggingTaskError(
        `TaggingTask grid embedding dimension mismatch: question ${queryEmbedding.length} vs knowledge ${vector.length}`,
      );
    }
    distances.set(row.id, cosineDistance(queryEmbedding, vector));
  }
  const pathKey = new Map(
    rows.map((row) => [row.id, buildPath(row.id, byId).join('\u0000')] as const),
  );
  return [...rows].sort((a, b) => {
    const distanceA = distances.get(a.id) ?? Number.POSITIVE_INFINITY;
    const distanceB = distances.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (distanceA !== distanceB) return distanceA - distanceB;
    const pathA = pathKey.get(a.id) ?? '';
    const pathB = pathKey.get(b.id) ?? '';
    if (pathA !== pathB) return pathA < pathB ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface BuildTaggingGridParams {
  subjectId?: string;
  /** Redacted question text; embedded only when the candidate set needs ranking. */
  questionMd: string;
  embedder: TaggingGridEmbedder;
}

export interface TaggingGridSnapshot {
  grid: TaggingInputT['grid'];
  grid_truncated: boolean;
}

/**
 * Builds the knowledge-grid snapshot the tagger picks ids from. Bounded to
 * MAX_GRID_NODES; when the subject has more active nodes, the head is chosen by
 * question-embedding relevance instead of an arbitrary storage slice, and the
 * truncation is reported instead of being silent.
 */
export async function buildTaggingGrid(
  db: Db,
  params: BuildTaggingGridParams,
): Promise<TaggingGridSnapshot> {
  const allNodes = await loadGridNodes(db, params.subjectId);
  const byId = new Map(allNodes.map((row) => [row.id, row]));
  const grid_truncated = allNodes.length > MAX_GRID_NODES;

  let selected = allNodes;
  if (grid_truncated) {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await params.embedder.embed(
        questionEmbedText({ prompt_md: params.questionMd, reference_md: null, choices_md: null }),
      );
    } catch (err) {
      throw new TaggingTaskError('TaggingTask grid embedding failed', { cause: err });
    }
    const vectors = await loadGridVectors(
      db,
      allNodes.map((row) => row.id),
    );
    selected = rankKnowledgeRows(allNodes, vectors, queryEmbedding, byId).slice(0, MAX_GRID_NODES);
  }

  const nodes = selected.map((row) => ({
    id: row.id,
    name: row.name,
    path: buildPath(row.id, byId),
  }));
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const edges = (await loadGridEdges(db, nodeIds)).filter(
    (e) => nodeIdSet.has(e.from_knowledge_id) && nodeIdSet.has(e.to_knowledge_id),
  );
  return { grid: { nodes, edges }, grid_truncated };
}

/**
 * Runs the TaggingTask. Returns a validated `TaggingOutput` plus the honest
 * `grid_truncated` flag. Suggestions are kept when the knowledge id exists as an
 * active library node, even if relevance truncation left it out of the prompt
 * grid; invented ids are dropped.
 */
export async function runTaggingTask(params: RunTaggingTaskParams): Promise<TaggingRunResult> {
  const questionMd = redactIngestionText(params.questionMd).text;
  const { grid, grid_truncated } = await buildTaggingGrid(params.db, {
    subjectId: params.subjectId,
    questionMd,
    embedder: params.embedder ?? createKnowledgeTagEmbedder(),
  });

  const input: TaggingInputT = TaggingInputSchema.parse({
    // The grid (KC names/ids) is internal vocabulary and stays as-is.
    question_md: questionMd,
    knowledge_hint: params.knowledgeHint
      ? redactIngestionText(params.knowledgeHint).text
      : params.knowledgeHint,
    grid,
  });

  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db);
  let llmText: string;
  try {
    const result = await runTaskFn('TaggingTask', input, params.ctx ?? {});
    llmText = result.text;
  } catch (err) {
    throw new TaggingTaskError('TaggingTask LLM call failed', { cause: err });
  }

  let parsed: TaggingOutputT;
  try {
    parsed = parseTaggingOutput(llmText);
  } catch (err) {
    if (err instanceof TaggingTaskError) throw err;
    throw new TaggingTaskError('TaggingTask output did not match TaggingOutput schema', {
      cause: err,
    });
  }

  // Existence check, not membership: a real library node stays accepted even when
  // it ranked past the prompt grid; only ids with no active row are hallucinations.
  const suggestedIds = [...new Set(parsed.suggestions.map((s) => s.knowledge_id))];
  const existingIds = new Set<string>();
  if (suggestedIds.length > 0) {
    const existing = await params.db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, suggestedIds), isNull(knowledge.archived_at)));
    for (const row of existing) existingIds.add(row.id);
  }
  const suggestions = parsed.suggestions.filter((s) => existingIds.has(s.knowledge_id));

  return { ...parsed, suggestions, grid_truncated };
}
