// Read-side closure of knowledge.merged_from. Answer rows keep the id they were
// written with; the survivor's readers expand that id instead of rewriting history.

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';

type DbLike = Db | Tx;

interface Absorber {
  id: string;
  archived: boolean;
}

export interface MergedKnowledgeClosure {
  /** Survivor plus every id merged into it, transitively. Always contains `id`. */
  closure(id: string): ReadonlySet<string>;
  /**
   * Live node that absorbed `id`. Null when `id` is not absorbed, the chain
   * cycles, or the chain ends on an archived node.
   */
  liveWinner(id: string): string | null;
}

export async function loadMergedKnowledgeClosure(db: DbLike): Promise<MergedKnowledgeClosure> {
  const rows = await db
    .select({
      id: knowledge.id,
      archived_at: knowledge.archived_at,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge)
    .where(sql`jsonb_array_length(${knowledge.merged_from}) > 0`);

  const mergedFrom = new Map<string, readonly string[]>();
  const archived = new Set<string>();
  const absorbedBy = new Map<string, Absorber>();
  for (const row of rows) {
    const fromIds = row.merged_from.filter((id) => id.length > 0);
    mergedFrom.set(row.id, fromIds);
    if (row.archived_at !== null) archived.add(row.id);
    const absorber: Absorber = { id: row.id, archived: row.archived_at !== null };
    for (const fromId of fromIds) {
      const current = absorbedBy.get(fromId);
      // Two absorbers is bad data. Keep a live one over an archived one.
      if (!current || (current.archived && !absorber.archived)) absorbedBy.set(fromId, absorber);
    }
  }

  return {
    closure(id: string): ReadonlySet<string> {
      const out = new Set<string>([id]);
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur) break;
        for (const fromId of mergedFrom.get(cur) ?? []) {
          if (out.has(fromId)) continue;
          out.add(fromId);
          stack.push(fromId);
        }
      }
      return out;
    },
    liveWinner(id: string): string | null {
      let cur = id;
      const seen = new Set<string>();
      for (;;) {
        const next = absorbedBy.get(cur);
        if (!next) break;
        if (seen.has(cur)) return null;
        seen.add(cur);
        cur = next.id;
      }
      if (cur === id || archived.has(cur)) return null;
      return cur;
    },
  };
}
