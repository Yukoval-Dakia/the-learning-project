import { eq, isNull } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { normalizeSubjectKey, resolveKnownSubjectId } from '@/subjects/profile';

const MAX_DEPTH = 32; // Cycle guard.

export function matchesSubjectDomain(subject: string, effectiveDomain: string | null): boolean {
  const rawKey = normalizeSubjectKey(subject);
  if (!rawKey || effectiveDomain === null) return false;

  const canonical = resolveKnownSubjectId(subject);
  if (canonical !== null) return resolveKnownSubjectId(effectiveDomain) === canonical;
  return normalizeSubjectKey(effectiveDomain) === rawKey;
}

/**
 * Walk parents to the first non-null domain. Invariant: a root has a domain.
 * Accepts Db or Tx so attempt transactions resolve domains in place.
 */
export async function getEffectiveDomain(db: Db | Tx, nodeId: string): Promise<string> {
  let curId: string = nodeId;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const row = (
      await db
        .select({ domain: knowledge.domain, parent_id: knowledge.parent_id })
        .from(knowledge)
        .where(eq(knowledge.id, curId))
        .limit(1)
    )[0];
    if (!row) {
      throw new Error(`knowledge node not found: ${curId}`);
    }
    if (row.domain !== null) {
      return row.domain;
    }
    if (row.parent_id === null) {
      throw new Error(`root node has null domain (invariant violation): ${curId}`);
    }
    curId = row.parent_id;
  }
  throw new Error(`getEffectiveDomain max depth ${MAX_DEPTH} exceeded for ${nodeId}`);
}

/**
 * Batch twin of getEffectiveDomain: loads the tree once, including archived rows, and
 * climbs in memory. Returns null exactly where the single walk throws, so callers
 * with a try/catch fallback get identical results.
 */
export async function batchResolveEffectiveDomains(
  db: Db | Tx,
  nodeIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = Array.from(new Set(nodeIds));
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: knowledge.id, domain: knowledge.domain, parent_id: knowledge.parent_id })
    .from(knowledge);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const effectiveDomain = (id: string): string | null => {
    let curId: string = id;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const row = byId.get(curId);
      if (!row) return null; // node not found → getEffectiveDomain throws → caught null.
      if (row.domain !== null) return row.domain;
      if (row.parent_id === null) return null; // root with null domain → throws → caught null.
      curId = row.parent_id;
    }
    return null; // MAX_DEPTH exceeded → getEffectiveDomain throws → caught null.
  };
  for (const id of ids) out.set(id, effectiveDomain(id));
  return out;
}

/**
 * Ancestor chain per id, self excluded, nearest first. Loads the tree once and caps
 * at MAX_DEPTH, so cycles exhaust the bound. A dangling parent stays in the chain.
 */
export async function batchResolveAncestorIds(
  db: Db | Tx,
  nodeIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = Array.from(new Set(nodeIds));
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: knowledge.id, parent_id: knowledge.parent_id })
    .from(knowledge);
  const parentById = new Map(rows.map((r) => [r.id, r.parent_id]));
  for (const id of ids) {
    const chain: string[] = [];
    let curId: string | null = parentById.get(id) ?? null;
    for (let depth = 0; curId !== null && depth < MAX_DEPTH; depth++) {
      chain.push(curId);
      curId = parentById.get(curId) ?? null;
    }
    out.set(id, chain);
  }
  return out;
}

/**
 * Active node ids whose effective domain matches the subject identity. The subject is
 * a derived join, never a question column. An empty result is an empty list, not a 404.
 */
export async function resolveSubjectKnowledgeIds(db: Db | Tx, subject: string): Promise<string[]> {
  // Canonicalize the param once: comparing raw aliases against canonical domains
  // misses them. An unregistered domain still matches by normalized raw key.
  const canonical = resolveKnownSubjectId(subject);
  const rawKey = normalizeSubjectKey(subject);
  if (!rawKey) return [];
  // Exclude only the synthetic seed root by id pattern; runtime topic roots are real
  // content, so parent_id IS NULL is not the criterion.
  const syntheticRootId = `seed:${canonical ?? rawKey}:root`;

  const rows = await db
    .select({
      id: knowledge.id,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));

  const byId = new Map(rows.map((row) => [row.id, row]));

  // Archived ancestors are absent from byId, so the walk stops there and yields null.
  const effectiveDomain = (id: string): string | null => {
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.domain) return current.domain;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return null;
  };

  const matched: string[] = [];
  for (const row of rows) {
    if (row.id === syntheticRootId) continue; // Structural anchor, never content.
    const domain = effectiveDomain(row.id);
    // Known subjects compare through resolveKnownSubjectId, so unknown domains never
    // fall into a default profile; an unregistered requested domain matches by raw key.
    if (matchesSubjectDomain(subject, domain)) matched.push(row.id);
  }
  return matched;
}

/**
 * Every active knowledge id, no subject filter. The cold-start tier-3 fallback for
 * placement when a day-one goal resolves no scope; the picker still requires an
 * eligible question, so empty subgraphs add no phantom KC.
 */
export async function resolveAllActiveKnowledgeIds(db: Db | Tx): Promise<string[]> {
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  return rows.map((row) => row.id);
}
