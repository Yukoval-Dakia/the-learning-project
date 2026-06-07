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

/**
 * Short-term OOM guard for {@link loadTreeSnapshot} (YUK-236 [STB-2]).
 *
 * `loadTreeSnapshot` loads the ENTIRE non-archived knowledge graph into memory
 * (then builds an in-memory `byId` map + walks parent chains). With no bound a
 * runaway graph could exhaust the worker / request heap. 5000 covers the
 * single-user graph by a wide margin (current real graphs are ~10²–10³ nodes).
 *
 * PHASE-DEFERRED (mid-term, tracked in YUK-236): replace the load-all snapshot
 * with a recursive-CTE / incremental walk so callers that only need a subtree
 * (goals scope, propose, hub-sync) don't materialise the whole graph. Until
 * then this cap + the truncation warn below are the safety net; if the warn
 * fires in prod it signals we've outgrown the load-all approach and should
 * prioritise the CTE rewrite.
 */
export const LOAD_TREE_SNAPSHOT_LIMIT = 5000;

/**
 * Emit a structured warn when a tree snapshot hit the {@link LOAD_TREE_SNAPSHOT_LIMIT}
 * cap (i.e. the result was almost certainly truncated and effective-domain /
 * parent-chain inheritance may be silently incomplete). Pure + injectable `warn`
 * so it is unit-testable without a DB (see tree.unit.test.ts).
 */
export function warnIfTreeSnapshotTruncated(
  rowCount: number,
  warn: (message: string, context: Record<string, unknown>) => void = console.warn,
): boolean {
  if (rowCount < LOAD_TREE_SNAPSHOT_LIMIT) return false;
  warn('[knowledge_tree] loadTreeSnapshot hit row cap — snapshot likely truncated', {
    event: 'tree_snapshot_truncated',
    limit: LOAD_TREE_SNAPSHOT_LIMIT,
    row_count: rowCount,
  });
  return true;
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
    .where(isNull(knowledge.archived_at))
    // Deterministic order BEFORE the cap (CODEX-3): a bare LIMIT with no ORDER BY
    // lets Postgres return an arbitrary 5000-row subset, so two callers on the
    // same data could see different rows — and a truncated subset could drop a
    // parent node, silently mis-computing a child's effective_domain. Ordering by
    // a stable key makes the truncated subset reproducible. (Root cause — the
    // load-all approach itself — is the YUK-236 CTE rewrite; this just makes the
    // interim cap deterministic.)
    .orderBy(knowledge.id)
    // Bound the load-all snapshot so a runaway graph can't OOM the heap. See the
    // LOAD_TREE_SNAPSHOT_LIMIT docblock for the phase-deferred CTE follow-up.
    .limit(LOAD_TREE_SNAPSHOT_LIMIT);
  warnIfTreeSnapshotTruncated(rows.length);
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
