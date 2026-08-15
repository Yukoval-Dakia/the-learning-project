import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { and, inArray, isNull } from 'drizzle-orm';

export async function assertKnowledgeIdsExist(
  db: Db,
  ids: string[],
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  if (ids.length === 0) return { ok: true };
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, ids), isNull(knowledge.archived_at)));
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}
