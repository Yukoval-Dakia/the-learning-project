import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { isNull } from 'drizzle-orm';

interface KnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: Date | null;
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
    })
    .from(knowledge)
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
