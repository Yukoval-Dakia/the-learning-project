import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { normalizeSubjectKey, resolveKnownSubjectId } from '@/subjects/profile';
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
 * YUK-716 — batch twin of {@link getEffectiveDomain} for MANY node ids in ONE query.
 *
 * Loads the FULL knowledge tree once (single user, hundreds of nodes; NO `archived_at` filter)
 * and climbs each id's parent chain IN MEMORY. Returns a Map id → domain (string) or `null`.
 * `null` is returned in EXACTLY the cases {@link getEffectiveDomain} THROWS — node-not-found,
 * root-with-null-domain, or MAX_DEPTH exceeded — so a caller that wraps the single walk in
 * try/catch → fallback (e.g. {@link effectiveThetaForKc}, `batchResolveSubjectIds`,
 * `batchResolveFamilyKeys`) gets a byte-identical result. The archived-INCLUSIVE load is the
 * SAME convergence `batchResolveFamilyKeys` relies on (walking through an archived intermediate
 * ancestor to its domain), so read-side domain resolution can never drift from the single walk.
 *
 * The in-memory climb is the EXACT structural mirror of {@link getEffectiveDomain}: it inspects
 * at most MAX_DEPTH nodes (climb levels 0..MAX_DEPTH-1) in the same branch order, so a chain
 * whose domain-bearing ancestor lies BEYOND the cap resolves to `null` here just as the single
 * walk throws max-depth there (→ callers' θ_global=0 fallback). The bounded `depth` counter also
 * subsumes cycle protection — a cycle exhausts the cap and yields `null`, matching the single
 * walk's max-depth throw.
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
 * Forward map: registered subject profile id OR an observed raw domain → the set of active
 * knowledge node ids whose effective domain matches that identity. This is the derived-axis primitive
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
export async function resolveSubjectKnowledgeIds(db: Db | Tx, subject: string): Promise<string[]> {
  // YUK-603 (v2 contract §5.4) — canonicalize the PARAM once up front. The per-row compare
  // below resolves each node's effective domain to its CANONICAL subject id, so comparing it
  // against the raw param made every alias arg ('wenyan') miss everything. YUK-628：如果请求
  // 的是注册表尚不认识、但知识树真实拥有的 domain，则保留规范化 raw key 做精确匹配；
  // 它是诚实读轴，不会把该 domain 注册成 profile。
  const canonical = resolveKnownSubjectId(subject);
  const rawKey = normalizeSubjectKey(subject);
  if (!rawKey) return [];
  // The synthetic seed root ('seed:<subject>:root', domain = the subject id itself) SELF-matches
  // and used to leak into every resolution — day-one that made the "subject KC set" non-empty
  // ([root]) and armed the goal scope-freeze bug. "科目的 KC 集" = content child KCs only; the
  // root is a structural anchor. Exclusion is by ID PATTERN, not `parent_id IS NULL` — 3a
  // runtime topic roots (newId + parent_id null) are genuine content and must stay.
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
    if (row.id === syntheticRootId) continue; // structural anchor, never content (§5.4)
    const domain = effectiveDomain(row.id);
    // Canonical bridge: a raw domain string maps to a subject id via the alias
    // table, so a `?subject=yuwen` tab matches any node whose domain ALIASES to
    // that profile (legacy wenyan / classical_chinese → yuwen) — alias-aware
    // where the bare-equality precedent (tagging.ts:122) is not.
    //
    // YUK-288 over-match fix: known subjects compare through resolveKnownSubjectId (NOT
    // resolveSubjectProfile), so null/unknown domains never fall into the DEFAULT profile.
    // YUK-628 adds a separate exact-raw branch only when the requested identity itself is
    // unregistered. Thus `?subject=yuwen` cannot sweep unknown nodes, while
    // `?subject=yingyu` can honestly select nodes whose real domain is exactly yingyu.
    if (canonical !== null) {
      if (resolveKnownSubjectId(domain) === canonical) matched.push(row.id);
    } else if (domain !== null && normalizeSubjectKey(domain) === rawKey) {
      matched.push(row.id);
    }
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
export async function resolveAllActiveKnowledgeIds(db: Db | Tx): Promise<string[]> {
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  return rows.map((row) => row.id);
}
