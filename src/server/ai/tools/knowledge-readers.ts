// YUK-102 / Foundation D M2
//
// Knowledge graph read tools. These keep graph traversal on the server side so
// Copilot / Dreaming callers receive bounded, named context instead of raw SQL
// row dumps.

import type { Db } from '@/db/client';
import { event, knowledge, knowledge_edge, knowledge_mastery } from '@/db/schema';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const TEXT_SNIPPET_MAX = 180;
const MAX_NODES = 60;
const RECENT_FAILURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type KnowledgeRow = {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
};

type EdgeRow = {
  id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight: number;
  reasoning: string | null;
};

function excerpt(value: string | null | undefined, max = TEXT_SNIPPET_MAX): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

async function loadKnowledgeRows(db: Db, subjectId?: string): Promise<KnowledgeRow[]> {
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

async function loadEdges(db: Db, ids?: string[], relationTypes?: string[]): Promise<EdgeRow[]> {
  const conditions = [isNull(knowledge_edge.archived_at)];
  if (ids && ids.length > 0) {
    const idCondition = or(
      inArray(knowledge_edge.from_knowledge_id, ids),
      inArray(knowledge_edge.to_knowledge_id, ids),
    );
    if (idCondition) conditions.push(idCondition);
  }
  if (relationTypes && relationTypes.length > 0) {
    conditions.push(inArray(knowledge_edge.relation_type, relationTypes));
  }
  return await db
    .select({
      id: knowledge_edge.id,
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
      weight: knowledge_edge.weight,
      reasoning: knowledge_edge.reasoning,
    })
    .from(knowledge_edge)
    .where(and(...conditions));
}

function nodeMap(rows: KnowledgeRow[]): Map<string, KnowledgeRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

function pathFor(id: string, byId: Map<string, KnowledgeRow>): string[] {
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

function childCount(id: string, rows: KnowledgeRow[]): number {
  return rows.filter((row) => row.parent_id === id).length;
}

function edgeCount(id: string, edges: EdgeRow[]): number {
  return edges.filter((edge) => edge.from_knowledge_id === id || edge.to_knowledge_id === id)
    .length;
}

function recentFailureCutoff(now = new Date()): Date {
  return new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS);
}

function knowledgePayloadContainsAny(ids: string[]) {
  const conditions = ids.map(
    (id) => sql`${event.payload}->'referenced_knowledge_ids' @> ${JSON.stringify([id])}::jsonb`,
  );
  return or(...conditions) ?? sql`FALSE`;
}

function payloadKnowledgeIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const ids = (payload as { referenced_knowledge_ids?: unknown }).referenced_knowledge_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

async function loadMasteryMap(
  db: Db,
  ids: string[],
): Promise<Map<string, { mastery: number | null; last_active_at: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      knowledge_id: knowledge_mastery.knowledge_id,
      mastery: knowledge_mastery.mastery,
      last_active_at: knowledge_mastery.last_active_at,
    })
    .from(knowledge_mastery)
    .where(inArray(knowledge_mastery.knowledge_id, ids));
  return new Map(
    rows.map((row) => [
      row.knowledge_id,
      {
        mastery: row.mastery ?? null,
        last_active_at: row.last_active_at?.toISOString() ?? null,
      },
    ]),
  );
}

async function loadRecentFailures(
  db: Db,
  ids: string[],
  limit = 10,
): Promise<
  Array<{
    event_id: string;
    question_id: string;
    cause: string | null;
    created_at: string;
    excerpt: string;
  }>
> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: event.id,
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      and(
        eq(event.action, 'attempt'),
        eq(event.subject_kind, 'question'),
        eq(event.outcome, 'failure'),
        knowledgePayloadContainsAny(ids),
      ),
    )
    .orderBy(sql`${event.created_at} DESC`)
    .limit(limit);
  return rows.map((row) => {
    const payload = row.payload as { answer_md?: string | null };
    return {
      event_id: row.id,
      question_id: row.subject_id,
      cause: null,
      created_at: row.created_at.toISOString(),
      excerpt: excerpt(payload.answer_md),
    };
  });
}

async function loadRecentFailureCounts(
  db: Db,
  ids: string[],
  since: Date,
): Promise<Map<string, number>> {
  const uniqueIds = Array.from(new Set(ids));
  const counts = new Map(uniqueIds.map((id) => [id, 0]));
  if (uniqueIds.length === 0) return counts;

  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'attempt'),
        eq(event.subject_kind, 'question'),
        eq(event.outcome, 'failure'),
        gte(event.created_at, since),
        knowledgePayloadContainsAny(uniqueIds),
      ),
    );

  const idSet = new Set(uniqueIds);
  for (const row of rows) {
    for (const id of payloadKnowledgeIds(row.payload)) {
      if (idSet.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

const RelationSchema = z.object({
  type: z.string(),
  direction: z.enum(['directed', 'symmetric']),
  meaning: z.string(),
});

const DEFAULT_RELATIONS = [
  {
    type: 'prerequisite',
    direction: 'directed' as const,
    meaning: 'from node is useful before learning to node',
  },
  { type: 'related_to', direction: 'symmetric' as const, meaning: 'nearby concepts' },
  {
    type: 'contrasts_with',
    direction: 'symmetric' as const,
    meaning: 'concepts that are easy to confuse',
  },
  { type: 'applied_in', direction: 'directed' as const, meaning: 'concept used in target context' },
  {
    type: 'derived_from',
    direction: 'directed' as const,
    meaning: 'target concept extends source',
  },
];

const OverviewInputSchema = z.object({
  subjectId: z.string().min(1),
  includeWeaknessSummary: z.boolean().optional(),
});

const OverviewOutputSchema = z.object({
  subject_id: z.string(),
  graph_version: z.number().int(),
  root_nodes: z.array(z.object({ id: z.string(), name: z.string() })),
  relation_types: z.array(RelationSchema),
  clusters: z.array(
    z.object({
      name: z.string(),
      root_id: z.string(),
      child_count: z.number().int(),
      edge_count: z.number().int(),
      weak_node_count: z.number().int().optional(),
      recent_failure_count_30d: z.number().int().optional(),
    }),
  ),
  reading_hint: z.string(),
});

type OverviewInput = z.infer<typeof OverviewInputSchema>;
type OverviewOutput = z.infer<typeof OverviewOutputSchema>;

async function executeOverview(ctx: ToolContext, raw: OverviewInput): Promise<OverviewOutput> {
  const input = OverviewInputSchema.parse(raw);
  const rows = await loadKnowledgeRows(ctx.db, input.subjectId);
  const ids = rows.map((row) => row.id);
  const edges = await loadEdges(ctx.db, ids);
  const mastery = input.includeWeaknessSummary ? await loadMasteryMap(ctx.db, ids) : new Map();
  const recentFailureCounts = input.includeWeaknessSummary
    ? await loadRecentFailureCounts(ctx.db, ids, recentFailureCutoff())
    : new Map<string, number>();
  const roots = rows.filter((row) => !row.parent_id || !ids.includes(row.parent_id));
  const clusters = roots.map((root) => {
    const descendantIds = new Set<string>([root.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.parent_id && descendantIds.has(row.parent_id) && !descendantIds.has(row.id)) {
          descendantIds.add(row.id);
          changed = true;
        }
      }
    }
    const cluster = {
      name: root.name,
      root_id: root.id,
      child_count: descendantIds.size - 1,
      edge_count: edges.filter(
        (edge) =>
          descendantIds.has(edge.from_knowledge_id) || descendantIds.has(edge.to_knowledge_id),
      ).length,
    } as OverviewOutput['clusters'][number];
    if (input.includeWeaknessSummary) {
      cluster.weak_node_count = [...descendantIds].filter((id) => {
        const m = mastery.get(id)?.mastery;
        return typeof m === 'number' && m < 0.55;
      }).length;
      cluster.recent_failure_count_30d = [...descendantIds].reduce(
        (sum, id) => sum + (recentFailureCounts.get(id) ?? 0),
        0,
      );
    }
    return cluster;
  });

  return OverviewOutputSchema.parse({
    subject_id: input.subjectId,
    graph_version: 1,
    root_nodes: roots.map((row) => ({ id: row.id, name: row.name })),
    relation_types: DEFAULT_RELATIONS,
    clusters,
    reading_hint:
      'Use knowledge.parent_id as the backbone tree; knowledge_edge is a typed mesh for prerequisites, contrasts, applications, and derived links.',
  });
}

const QueryKnowledgeInputSchema = z.object({
  subjectId: z.string().min(1),
  query: z.string().optional(),
  nodeId: z.string().optional(),
  include: z
    .array(z.enum(['ancestors', 'children', 'neighbors', 'stats', 'recent_failures']))
    .optional(),
  relationTypes: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const QueryKnowledgeOutputSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      parent_id: z.string().nullable(),
      path: z.array(z.string()),
      children_count: z.number().int(),
      edge_count: z.number().int(),
      stats: z
        .object({
          recent_failure_count_30d: z.number().int(),
          last_touched_at: z.string().nullable(),
          mastery_estimate: z.number().nullable(),
        })
        .optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from_knowledge_id: z.string(),
      to_knowledge_id: z.string(),
      relation_type: z.string(),
      weight: z.number(),
      evidence_event_ids: z.array(z.string()),
    }),
  ),
  recent_failures: z
    .array(
      z.object({
        event_id: z.string(),
        question_id: z.string(),
        cause: z.string().nullable(),
        created_at: z.string(),
        excerpt: z.string(),
      }),
    )
    .optional(),
});

type QueryKnowledgeInput = z.infer<typeof QueryKnowledgeInputSchema>;
type QueryKnowledgeOutput = z.infer<typeof QueryKnowledgeOutputSchema>;

async function executeQueryKnowledge(
  ctx: ToolContext,
  raw: QueryKnowledgeInput,
): Promise<QueryKnowledgeOutput> {
  const input = QueryKnowledgeInputSchema.parse(raw);
  const limit = input.limit ?? 10;
  const rows = await loadKnowledgeRows(ctx.db, input.subjectId);
  const byId = nodeMap(rows);
  const allEdges = await loadEdges(
    ctx.db,
    rows.map((row) => row.id),
    input.relationTypes,
  );
  let seedMatches = rows;
  if (input.nodeId) {
    seedMatches = rows.filter((row) => row.id === input.nodeId);
  } else if (input.query) {
    const q = input.query.toLowerCase();
    seedMatches = rows.filter(
      (row) => row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q),
    );
  }
  const included = input.include ?? [];
  const selected = new Map<string, KnowledgeRow>();
  const addSelected = (id: string) => {
    const row = byId.get(id);
    if (row && !selected.has(row.id)) selected.set(row.id, row);
  };
  for (const row of seedMatches.slice(0, limit)) addSelected(row.id);
  const seedIds = [...selected.keys()];

  if (included.includes('ancestors')) {
    for (const id of seedIds) {
      let current = byId.get(id);
      const seen = new Set<string>();
      while (current?.parent_id && !seen.has(current.id)) {
        seen.add(current.id);
        addSelected(current.parent_id);
        current = byId.get(current.parent_id);
      }
    }
  }
  if (included.includes('children')) {
    for (const id of seedIds) {
      for (const row of rows) {
        if (row.parent_id === id) addSelected(row.id);
      }
    }
  }
  if (included.includes('neighbors')) {
    const seedSet = new Set(seedIds);
    for (const edge of allEdges) {
      if (seedSet.has(edge.from_knowledge_id)) addSelected(edge.to_knowledge_id);
      if (seedSet.has(edge.to_knowledge_id)) addSelected(edge.from_knowledge_id);
    }
  }

  const matches = [...selected.values()].slice(0, limit);
  const ids = matches.map((row) => row.id);
  const mastery = included.includes('stats') ? await loadMasteryMap(ctx.db, ids) : new Map();
  const failureCounts = included.includes('stats')
    ? await loadRecentFailureCounts(ctx.db, ids, recentFailureCutoff())
    : new Map<string, number>();
  const failures = included.includes('recent_failures')
    ? await loadRecentFailures(ctx.db, ids, 10)
    : undefined;

  const selectedIds = new Set(ids);

  return QueryKnowledgeOutputSchema.parse({
    nodes: matches.map((row) => {
      const m = mastery.get(row.id);
      return {
        id: row.id,
        name: row.name,
        parent_id: row.parent_id,
        path: pathFor(row.id, byId),
        children_count: childCount(row.id, rows),
        edge_count: edgeCount(row.id, allEdges),
        ...(included.includes('stats')
          ? {
              stats: {
                recent_failure_count_30d: failureCounts.get(row.id) ?? 0,
                last_touched_at: m?.last_active_at ?? null,
                mastery_estimate: m?.mastery ?? null,
              },
            }
          : {}),
      };
    }),
    edges: allEdges
      .filter(
        (edge) => selectedIds.has(edge.from_knowledge_id) && selectedIds.has(edge.to_knowledge_id),
      )
      .map((edge) => ({
        id: edge.id,
        from_knowledge_id: edge.from_knowledge_id,
        to_knowledge_id: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        weight: edge.weight,
        evidence_event_ids: [],
      })),
    ...(failures ? { recent_failures: failures } : {}),
  });
}

const ExpandInputSchema = z.object({
  centerNodeId: z.string().min(1),
  depth: z.number().int().min(1).max(3).optional(),
  include: z
    .array(z.enum(['ancestors', 'children', 'neighbors', 'recent_failures', 'mastery']))
    .optional(),
  relationTypes: z.array(z.string()).optional(),
  maxNodes: z.number().int().min(1).max(MAX_NODES).optional(),
});

const ExpandOutputSchema = z.object({
  center: z.object({ id: z.string(), name: z.string(), path: z.array(z.string()) }).nullable(),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.array(z.string()),
      role: z.enum(['ancestor', 'child', 'neighbor', 'center']),
    }),
  ),
  edges: z.array(
    z.object({ from: z.string(), to: z.string(), relation_type: z.string(), weight: z.number() }),
  ),
  paths: z.array(
    z.object({ from: z.string(), to: z.string(), relation_type: z.string(), reason: z.string() }),
  ),
  evidence: z.object({
    recent_failures: z.array(
      z.object({
        event_id: z.string(),
        question_id: z.string(),
        cause: z.string().nullable(),
        excerpt: z.string(),
      }),
    ),
    weak_points: z.array(
      z.object({ knowledge_id: z.string(), signal: z.string(), score: z.number() }),
    ),
  }),
});

type ExpandInput = z.infer<typeof ExpandInputSchema>;
type ExpandOutput = z.infer<typeof ExpandOutputSchema>;

async function executeExpand(ctx: ToolContext, raw: ExpandInput): Promise<ExpandOutput> {
  const input = ExpandInputSchema.parse(raw);
  const maxNodes = input.maxNodes ?? 30;
  const allRows = await loadKnowledgeRows(ctx.db);
  const byId = nodeMap(allRows);
  const center = byId.get(input.centerNodeId);
  if (!center) {
    return ExpandOutputSchema.parse({
      center: null,
      nodes: [],
      edges: [],
      paths: [],
      evidence: { recent_failures: [], weak_points: [] },
    });
  }
  const allEdges = await loadEdges(ctx.db, undefined, input.relationTypes);
  const included = input.include ?? ['ancestors', 'children', 'neighbors'];
  const selected = new Map<string, 'ancestor' | 'child' | 'neighbor' | 'center'>([
    [center.id, 'center'],
  ]);
  if (included.includes('ancestors')) {
    let current = center;
    while (current.parent_id) {
      const parent = byId.get(current.parent_id);
      if (!parent) break;
      selected.set(parent.id, 'ancestor');
      current = parent;
    }
  }
  if (included.includes('children')) {
    let frontier = [center.id];
    for (let d = 0; d < (input.depth ?? 1); d += 1) {
      const next = allRows.filter((row) => row.parent_id && frontier.includes(row.parent_id));
      for (const row of next) selected.set(row.id, 'child');
      frontier = next.map((row) => row.id);
    }
  }
  if (included.includes('neighbors')) {
    for (const edge of allEdges) {
      if (edge.from_knowledge_id === center.id && byId.has(edge.to_knowledge_id)) {
        selected.set(edge.to_knowledge_id, 'neighbor');
      }
      if (edge.to_knowledge_id === center.id && byId.has(edge.from_knowledge_id)) {
        selected.set(edge.from_knowledge_id, 'neighbor');
      }
    }
  }
  const selectedIds = [...selected.keys()].slice(0, maxNodes);
  const selectedSet = new Set(selectedIds);
  const failures = included.includes('recent_failures')
    ? await loadRecentFailures(ctx.db, selectedIds, 10)
    : [];
  const mastery = included.includes('mastery')
    ? await loadMasteryMap(ctx.db, selectedIds)
    : new Map();

  return ExpandOutputSchema.parse({
    center: { id: center.id, name: center.name, path: pathFor(center.id, byId) },
    nodes: selectedIds.map((id) => {
      const row = byId.get(id) as KnowledgeRow;
      return { id, name: row.name, path: pathFor(id, byId), role: selected.get(id) ?? 'neighbor' };
    }),
    edges: allEdges
      .filter(
        (edge) => selectedSet.has(edge.from_knowledge_id) && selectedSet.has(edge.to_knowledge_id),
      )
      .map((edge) => ({
        from: edge.from_knowledge_id,
        to: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        weight: edge.weight,
      })),
    paths: allEdges
      .filter(
        (edge) =>
          (edge.from_knowledge_id === center.id || edge.to_knowledge_id === center.id) &&
          byId.has(edge.from_knowledge_id) &&
          byId.has(edge.to_knowledge_id),
      )
      .map((edge) => ({
        from: edge.from_knowledge_id,
        to: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        reason: edge.reasoning ?? `${edge.relation_type} relation around ${center.name}`,
      })),
    evidence: {
      recent_failures: failures.map((f) => ({
        event_id: f.event_id,
        question_id: f.question_id,
        cause: f.cause,
        excerpt: f.excerpt,
      })),
      weak_points: [...mastery.entries()]
        .filter(([, m]) => typeof m.mastery === 'number' && (m.mastery as number) < 0.55)
        .map(([knowledgeId, m]) => ({
          knowledge_id: knowledgeId,
          signal: 'low_mastery',
          score: m.mastery ?? 0,
        })),
    },
  });
}

const PathsInputSchema = z.object({
  fromKnowledgeId: z.string().min(1),
  toKnowledgeId: z.string().min(1),
  maxDepth: z.number().int().min(1).max(5).optional(),
  relationTypes: z.array(z.string()).optional(),
});

const PathsOutputSchema = z.object({
  paths: z.array(
    z.object({
      node_ids: z.array(z.string()),
      node_names: z.array(z.string()),
      edge_types: z.array(z.string()),
      explanation: z.string(),
    }),
  ),
});

type PathsInput = z.infer<typeof PathsInputSchema>;
type PathsOutput = z.infer<typeof PathsOutputSchema>;

async function executePaths(ctx: ToolContext, raw: PathsInput): Promise<PathsOutput> {
  const input = PathsInputSchema.parse(raw);
  const maxDepth = input.maxDepth ?? 4;
  const rows = await loadKnowledgeRows(ctx.db);
  const byId = nodeMap(rows);
  const edges = await loadEdges(ctx.db, undefined, input.relationTypes);
  const adjacency = new Map<string, Array<{ to: string; type: string }>>();
  const add = (from: string, to: string, type: string) => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, type });
    adjacency.set(from, list);
  };
  for (const row of rows) {
    if (row.parent_id) {
      add(row.parent_id, row.id, 'tree_child');
      add(row.id, row.parent_id, 'tree_parent');
    }
  }
  for (const edge of edges) {
    add(edge.from_knowledge_id, edge.to_knowledge_id, edge.relation_type);
    if (edge.relation_type === 'related_to' || edge.relation_type === 'contrasts_with') {
      add(edge.to_knowledge_id, edge.from_knowledge_id, edge.relation_type);
    }
  }

  const found: PathsOutput['paths'] = [];
  const queue: Array<{ ids: string[]; types: string[] }> = [
    { ids: [input.fromKnowledgeId], types: [] },
  ];
  while (queue.length > 0 && found.length < 5) {
    const current = queue.shift() as { ids: string[]; types: string[] };
    const last = current.ids[current.ids.length - 1];
    if (last === input.toKnowledgeId) {
      const names = current.ids.map((id) => byId.get(id)?.name ?? id);
      found.push({
        node_ids: current.ids,
        node_names: names,
        edge_types: current.types,
        explanation: `${names.join(' → ')} via ${current.types.join(' / ') || 'same node'}`,
      });
      continue;
    }
    if (current.types.length >= maxDepth) continue;
    for (const next of adjacency.get(last) ?? []) {
      if (current.ids.includes(next.to)) continue;
      queue.push({ ids: [...current.ids, next.to], types: [...current.types, next.type] });
    }
  }
  return PathsOutputSchema.parse({ paths: found });
}

export const getSubjectGraphOverviewTool: DomainTool<OverviewInput, OverviewOutput> = {
  name: 'get_subject_graph_overview',
  description:
    'Read a compact subject knowledge graph overview: roots, relation legend, clusters, and reading hint.',
  effect: 'read',
  inputSchema: OverviewInputSchema,
  outputSchema: OverviewOutputSchema,
  costClass: 'local',
  execute: executeOverview,
  summarize(input, output) {
    return `graph overview · ${input.subjectId} · ${output.root_nodes.length} roots · ${output.clusters.length} clusters`;
  },
  mirrorEvent: 'when_user_visible',
};

export const queryKnowledgeTool: DomainTool<QueryKnowledgeInput, QueryKnowledgeOutput> = {
  name: 'query_knowledge',
  description:
    'Find knowledge nodes by id or text and return path, local edge counts, optional stats, and recent failure snippets.',
  effect: 'read',
  inputSchema: QueryKnowledgeInputSchema,
  outputSchema: QueryKnowledgeOutputSchema,
  costClass: 'local',
  execute: executeQueryKnowledge,
  summarize(input, output) {
    const target = input.nodeId ?? input.query ?? input.subjectId;
    return `knowledge · ${target} · ${output.nodes.length} nodes · ${output.edges.length} edges`;
  },
  mirrorEvent: 'when_user_visible',
};

export const expandKnowledgeSubgraphTool: DomainTool<ExpandInput, ExpandOutput> = {
  name: 'expand_knowledge_subgraph',
  description:
    'Read a bounded local graph around one knowledge node: ancestors, children, mesh neighbors, and optional evidence.',
  effect: 'read',
  inputSchema: ExpandInputSchema,
  outputSchema: ExpandOutputSchema,
  costClass: 'local',
  execute: executeExpand,
  summarize(input, output) {
    return `subgraph · ${input.centerNodeId} · ${output.nodes.length} nodes · ${output.edges.length} edges`;
  },
  mirrorEvent: 'when_user_visible',
};

export const findKnowledgePathsTool: DomainTool<PathsInput, PathsOutput> = {
  name: 'find_knowledge_paths',
  description:
    'Find short tree/mesh paths between two knowledge nodes for "why are these related" explanations.',
  effect: 'read',
  inputSchema: PathsInputSchema,
  outputSchema: PathsOutputSchema,
  costClass: 'local',
  execute: executePaths,
  summarize(input, output) {
    return `knowledge paths · ${input.fromKnowledgeId}→${input.toKnowledgeId} · ${output.paths.length} paths`;
  },
  mirrorEvent: 'when_user_visible',
};
