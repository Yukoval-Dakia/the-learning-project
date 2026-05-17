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
  const byId = new Map<string, KnowledgeRow>();
  for (const r of rows) byId.set(r.id, r);
  return rows.map((r) => {
    let cur: KnowledgeRow | undefined = r;
    let depth = 0;
    while (depth < 32 && cur && cur.domain === null && cur.parent_id !== null) {
      const next = byId.get(cur.parent_id);
      if (next === undefined) break;
      cur = next;
      depth++;
    }
    return { ...r, effective_domain: cur?.domain ?? null };
  });
}
