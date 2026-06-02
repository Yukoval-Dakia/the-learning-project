import type { Db } from '@/db/client';
import { knowledge, knowledge_mastery } from '@/db/schema';
import { eq, isNull, sql } from 'drizzle-orm';

interface KnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: Date | null;
  mastery: number | null;
  evidence_count: number;
  last_evidence_at: Date | null;
  last_active_at: Date;
}

export interface KnowledgeNode extends KnowledgeRow {
  effective_domain: string | null;
}

export async function loadTreeSnapshot(db: Db): Promise<KnowledgeNode[]> {
  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      mastery: knowledge_mastery.mastery,
      evidence_count: sql<number>`COALESCE(${knowledge_mastery.evidence_count}, 0)`,
      last_evidence_at: knowledge_mastery.last_evidence_at,
      last_active_at: sql<Date>`COALESCE(${knowledge_mastery.last_active_at}, ${knowledge.created_at})`,
    })
    .from(knowledge)
    .leftJoin(knowledge_mastery, eq(knowledge_mastery.knowledge_id, knowledge.id))
    .where(isNull(knowledge.archived_at));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const effectiveDomainById = new Map<string, string | null>();
  const sourceDepthById = new Map<string, number>();

  function cachePath(path: KnowledgeRow[], domain: string | null, terminalDepth: number) {
    for (const [index, pathRow] of path.entries()) {
      effectiveDomainById.set(pathRow.id, domain);
      sourceDepthById.set(pathRow.id, path.length - index + terminalDepth);
    }
  }

  function effectiveDomainFor(row: KnowledgeRow): string | null {
    const path: KnowledgeRow[] = [];
    const seen = new Set<string>();
    let cur: KnowledgeRow | undefined = row;

    while (path.length < 33 && cur) {
      const cachedDepth = sourceDepthById.get(cur.id);
      if (
        effectiveDomainById.has(cur.id) &&
        cachedDepth !== undefined &&
        path.length + cachedDepth < 32
      ) {
        const domain = effectiveDomainById.get(cur.id) ?? null;
        cachePath(path, domain, cachedDepth);
        return domain;
      }

      path.push(cur);
      if (cur.domain !== null || cur.parent_id === null || seen.has(cur.id)) {
        cachePath(path, cur.domain, -1);
        return cur.domain;
      }
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }

    cachePath(path, null, 0);
    return null;
  }

  return rows.map((r) => ({ ...r, effective_domain: effectiveDomainFor(r) }));
}
