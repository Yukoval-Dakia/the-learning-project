import { inArray, or, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge, knowledge_edge, learning_record } from '@/db/schema';

const EXCERPT_MAX = 220;

type KnowledgeRow = {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
};

export function excerpt(value: string | null | undefined, max = EXCERPT_MAX): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

async function loadKnowledgeRows(db: Db, ids: string[]): Promise<Map<string, KnowledgeRow>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const idOrParent = or(inArray(knowledge.id, unique), inArray(knowledge.parent_id, unique));
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, parent_id: knowledge.parent_id })
    .from(knowledge)
    .where(idOrParent ?? inArray(knowledge.id, unique));

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (;;) {
    const missingParents = [...byId.values()]
      .map((row) => row.parent_id)
      .filter((id): id is string => !!id && !byId.has(id));
    if (missingParents.length === 0) break;
    const parents = await db
      .select({ id: knowledge.id, name: knowledge.name, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(inArray(knowledge.id, [...new Set(missingParents)]));
    if (parents.length === 0) break;
    for (const parent of parents) byId.set(parent.id, parent);
  }
  return byId;
}

function pathFor(id: string, byId: Map<string, KnowledgeRow>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current.name);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return out;
}

export async function knowledgeContext(
  db: Db,
  ids: string[],
): Promise<Array<{ knowledge_id: string; path: string[]; mastery: number | null }>> {
  const byId = await loadKnowledgeRows(db, ids);
  return [...new Set(ids)].map((id) => ({
    knowledge_id: id,
    path: pathFor(id, byId),
    mastery: null,
  }));
}

export function knowledgeEdgeTouches(ids: string[]) {
  return (
    or(
      inArray(knowledge_edge.from_knowledge_id, ids),
      inArray(knowledge_edge.to_knowledge_id, ids),
    ) ?? inArray(knowledge_edge.from_knowledge_id, ids)
  );
}

export function recordKnowledgeContainsAny(ids: string[]) {
  const conditions = ids.map(
    (id) => sql`${learning_record.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  return or(...conditions) ?? sql`FALSE`;
}

export function bodyBlockSummaries(bodyBlocks: unknown): string[] {
  if (!bodyBlocks || typeof bodyBlocks !== 'object' || !('content' in bodyBlocks)) return [];
  if (!Array.isArray(bodyBlocks.content)) return [];
  return bodyBlocks.content.slice(0, 6).map((block) => {
    if (!block || typeof block !== 'object') return 'block';
    const type = 'type' in block && typeof block.type === 'string' ? block.type : undefined;
    const attrs =
      'attrs' in block && block.attrs && typeof block.attrs === 'object' ? block.attrs : undefined;
    const semanticKind =
      attrs && 'semantic_kind' in attrs && typeof attrs.semantic_kind === 'string'
        ? attrs.semantic_kind
        : undefined;
    const title =
      attrs && 'title' in attrs && typeof attrs.title === 'string' ? attrs.title : undefined;
    const content = 'content' in block && Array.isArray(block.content) ? block.content : [];
    const text = JSON.stringify(content)
      .replace(/[{}[\]",:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `${semanticKind ?? type ?? 'block'}: ${excerpt(title ?? text, 120)}`;
  });
}
