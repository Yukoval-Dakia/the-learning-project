/**
 * TaggingTask invoker — T-OC slice 3 (YUK-145, OC-4).
 *
 * See `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-4) +
 * `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` §5 + ADR-0026.
 *
 * Single-shot structured-output AI task (NOT multimodal): builds a knowledge-grid
 * snapshot (nodes + mesh edges), renders the extracted question text + optional
 * knowledge_hint, calls `runTask('TaggingTask', ...)`, parses strict JSON via the
 * `TaggingOutput` Zod schema, and FILTERS OUT any suggestion whose knowledge_id
 * is not in the grid (anti-hallucination belt-and-suspenders — the prompt also
 * forbids it). Mirrors `runStructureTask` / `runStepsJudge`: injectable
 * `runTaskFn` for testability.
 */
import {
  TaggingInput as TaggingInputSchema,
  type TaggingInputT,
  TaggingOutput,
  type TaggingOutputT,
} from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { and, inArray, isNull, or } from 'drizzle-orm';

/**
 * Thrown when the TaggingTask cannot produce a usable result (provider down,
 * unparseable output). Callers (auto-enroll) treat this as "route to review" —
 * a tagging outage must never auto-enroll, only ever fall back to human review.
 */
export class TaggingTaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TaggingTaskError';
  }
}

export type TaggingRunTaskFn = (
  kind: string,
  input: TaggingInputT,
  ctx: unknown,
) => Promise<{ text: string }>;

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
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

const MAX_GRID_NODES = 200;

type KnowledgeRow = { id: string; name: string; domain: string | null; parent_id: string | null };

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

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new TaggingTaskError('TaggingTask output did not contain a JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new TaggingTaskError('TaggingTask output was not valid JSON', { cause: err });
  }
}

async function defaultRunTaskFn(
  kind: string,
  input: TaggingInputT,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
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

/**
 * Builds the knowledge-grid snapshot the tagger picks ids from. Bounded to
 * MAX_GRID_NODES so a large graph cannot blow the prompt budget.
 */
export async function buildTaggingGrid(db: Db, subjectId?: string): Promise<TaggingInputT['grid']> {
  const allNodes = await loadGridNodes(db, subjectId);
  const byId = new Map(allNodes.map((row) => [row.id, row]));
  const nodes = allNodes.slice(0, MAX_GRID_NODES).map((row) => ({
    id: row.id,
    name: row.name,
    path: buildPath(row.id, byId),
  }));
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const edges = (await loadGridEdges(db, nodeIds)).filter(
    (e) => nodeIdSet.has(e.from_knowledge_id) && nodeIdSet.has(e.to_knowledge_id),
  );
  return { nodes, edges };
}

/**
 * Runs the TaggingTask. Returns a validated `TaggingOutput` with every suggestion
 * guaranteed to reference a real grid node id (hallucinated ids are dropped). On
 * provider failure / unparseable output throws `TaggingTaskError` so the caller
 * can route the block to human review instead of auto-enrolling.
 */
export async function runTaggingTask(params: RunTaggingTaskParams): Promise<TaggingOutputT> {
  const grid = await buildTaggingGrid(params.db, params.subjectId);

  const input: TaggingInputT = TaggingInputSchema.parse({
    question_md: params.questionMd,
    knowledge_hint: params.knowledgeHint,
    grid,
  });

  const runTaskFn = params.runTaskFn ?? defaultRunTaskFn;
  let llmText: string;
  try {
    const result = await runTaskFn('TaggingTask', input, params.ctx ?? { db: params.db });
    llmText = result.text;
  } catch (err) {
    throw new TaggingTaskError('TaggingTask LLM call failed', { cause: err });
  }

  let parsed: TaggingOutputT;
  try {
    parsed = TaggingOutput.parse(extractJsonObject(llmText));
  } catch (err) {
    if (err instanceof TaggingTaskError) throw err;
    throw new TaggingTaskError('TaggingTask output did not match TaggingOutput schema', {
      cause: err,
    });
  }

  // Anti-hallucination: drop any suggestion whose knowledge_id is not in the grid.
  const gridIds = new Set(grid.nodes.map((n) => n.id));
  const suggestions = parsed.suggestions.filter((s) => gridIds.has(s.knowledge_id));

  return { ...parsed, suggestions };
}
