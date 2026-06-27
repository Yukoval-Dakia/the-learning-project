import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { eq, isNull } from 'drizzle-orm';

const MAX_DEPTH = 32; // 防 cycle

/**
 * Walk up parent chain to find first non-null domain.
 * Invariant: parent_id IS NULL ↔ domain IS NOT NULL（root 必有 domain）。
 *
 * GET /api/knowledge does its own in-memory walk over the full tree (batch-friendly),
 * so this single-node helper is for per-node domain lookups (e.g. resolving a node's
 * domain within an attempt tx — see the YUK-361 Phase 5 family-calibration caller below).
 *
 * Accepts `Db | Tx` (read-only SELECTs only) so callers inside an attempt tx
 * (YUK-361 Phase 5 家族级校准的 subject 派生) can resolve a node's domain within
 * the same transaction without a cast.
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
 * Forward map: subject profile id → the set of active knowledge node ids whose
 * effective domain resolves to that subject. This is the derived-axis primitive
 * behind `GET /api/questions?subject=` (YUK-288): a question's subject is a
 * DERIVED join through `question.knowledge_ids → knowledge.(effective)domain →
 * resolveSubjectProfile.id`, never a column on `question` (subject 模型终版第 2 条
 * / YUK-249).
 *
 * Resolution mirrors the canonical bridge (`getEffectiveDomain →
 * resolveSubjectProfile.id`) used by `batchResolveSubjectIds` and the review
 * scheduler, and the in-memory effective-domain walk in
 * `ingestion/tagging.ts:loadGridNodes` (same algorithm, lifted here as the
 * shared forward mapping rather than re-inlining it). One pass over the active
 * knowledge tree (single user, hundreds of nodes), so no N+1 per-node walk.
 *
 * Returns the matching node ids. An empty result means the subject currently
 * labels no questions; the caller (list reader) turns that into an empty list,
 * not a 404.
 */
export async function resolveSubjectKnowledgeIds(db: Db, subject: string): Promise<string[]> {
  const rows = await db
    .select({
      id: knowledge.id,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));

  const byId = new Map(rows.map((row) => [row.id, row]));

  // In-memory effective-domain walk (mirrors tagging.ts:112 / resolveEffectiveDomain):
  // climb parent_id until a non-null domain, stopping on cycles. An archived
  // ancestor is already absent from `byId`, so the walk stops at it and yields
  // null — matching the archived-ancestor cutoff elsewhere (Codex #193 / YUK-161).
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
    const domain = effectiveDomain(row.id);
    // Canonical bridge: a raw domain string maps to a subject id via the alias
    // table, so a `?subject=wenyan` tab matches any node whose domain ALIASES to
    // that profile (classical_chinese → wenyan) — alias-aware where the bare-
    // equality precedent (tagging.ts:122) is not.
    //
    // YUK-288 over-match fix: we use resolveKnownSubjectId (NOT resolveSubjectProfile),
    // which returns null for a null effective domain OR an unrecognised string
    // instead of falling back to the DEFAULT profile (wenyan). Without this, every
    // untagged-up-the-whole-chain node and every unknown-domain node resolved to
    // 'wenyan' and was swept into `?subject=wenyan`, conflating "genuinely wenyan"
    // with "untagged / unknown-domain". A null result matches no subject.
    if (resolveKnownSubjectId(domain) === subject) matched.push(row.id);
  }
  return matched;
}

/**
 * Full active-tree KC set: every non-archived knowledge node id, with no subject
 * filter. This is the cold-start TIER-3 fallback behind placement scope resolution
 * (YUK-481, `placement-start.ts`).
 *
 * Tier-1 of that resolution uses a goal's frozen `scope_knowledge_ids`; tier-2
 * live-resolves the goal's `subject_id` via `resolveSubjectKnowledgeIds`
 * (effective-domain axis). Tier-3 fires when BOTH yield empty — a day-one goal that
 * is cross-subject / has no `subject_id` / whose subject root is planted but has no
 * child KC yet. Rather than 400 (which would block the cold-start probe), placement
 * falls back to the WHOLE active tree so the learner can still be placed. It is a
 * cold-start crutch: once a subject is selected or uploads grow KCs, tier-2 takes
 * over. `selectNextPlacementItem` already filters to KCs with ≥1 eligible question,
 * so an empty subgraph (e.g. a subject seed root) introduces no phantom KC.
 *
 * Reuses the same `archived_at IS NULL` scan as `resolveSubjectKnowledgeIds`. n=1
 * admissible: the result is the single learner's own active-tree id set — a derived
 * view, never a per-subject parameter (subject 模型终版第 2 条: scope is a derived
 * axis, not a column).
 */
export async function resolveAllActiveKnowledgeIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  return rows.map((row) => row.id);
}
