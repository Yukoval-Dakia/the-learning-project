import type { D1Database } from '@cloudflare/workers-types';

interface KnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: number | null;
}

export interface KnowledgeNode extends KnowledgeRow {
  effective_domain: string | null;
}

export async function loadTreeSnapshot(db: D1Database): Promise<KnowledgeNode[]> {
  const rows = await db
    .prepare(
      `select id, name, domain, parent_id, archived_at from knowledge where archived_at is null`,
    )
    .bind()
    .all<KnowledgeRow>();
  const byId = new Map<string, KnowledgeRow>();
  for (const r of rows.results) byId.set(r.id, r);
  return rows.results.map((r) => {
    let cur: KnowledgeRow | undefined = r;
    let depth = 0;
    while (depth < 32 && cur && cur.domain === null && cur.parent_id !== null) {
      depth++;
      const next = byId.get(cur.parent_id);
      if (next === undefined) break;
      if (depth >= 32) break;
      cur = next;
    }
    return { ...r, effective_domain: cur?.domain ?? null };
  });
}
