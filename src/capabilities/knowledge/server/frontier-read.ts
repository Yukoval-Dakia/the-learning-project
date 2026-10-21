// FrontierRail read model. The dense half comes from live prerequisite edges; the
// propose half comes from pending (non-live) proposals and is always tagged as a
// low-confidence suggestion. The two halves never mix: a proposed edge cannot enter
// the live frontier, and reasons/bands stay qualitative rather than raw probabilities.
//
// This module owns the whole frontier graph decision (closure, mastery gate,
// sparse/dense/overflow discrimination) so the rail and the graph share one owner.

import { and, desc, eq, inArray, isNull, notLike, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';

// The learnable frontier: KCs whose transitive prerequisites are all mastered and
// which are not mastered themselves.
//
// - A KC is a candidate only when it has at least one live prerequisite, so empty
//   graphs stay empty instead of vacuously qualifying every KC.
// - Archived edges never gate or surface anything.
// - The closure is a set walk (UNION), so diamonds collapse instead of exploding;
//   depth and rowcount overflows fail safe to an empty frontier, never a partial one.
// - Topology stays in SQL; the mastery predicate stays in TS on getMasteryProjection.

type DbLike = Db | Tx;

/** Hard depth bound on the transitive prereq closure walk (cycle/run-away guard). */
export const FRONTIER_DEPTH_LIMIT = 16;
/**
 * Runaway backstop on distinct (frontier, prereq) pairs, not on path count: the
 * closure's rowcount grows with graph density, so a tight cap would blank a real
 * frontier. Only a pathological fan-out or an escaping cycle should trip it.
 */
export const FRONTIER_NODE_CAP = 10_000;

/** p(L) at which a KC counts as mastered; always pair it with the evidence floor. */
export const MASTERED_PL_THRESHOLD = 0.7;

/**
 * Evidence floor for mastery. p(L) alone crosses 0.7 after three lucky corrects, so
 * the floor blocks that without changing the model. A borrowed estimate has no
 * evidence and therefore never unlocks a dependent.
 */
export const FRONTIER_MASTERY_MIN_EVIDENCE = 4;

/** Mastered enough for frontier purposes: clears both the p(L) gate and the evidence floor. */
export function isMasteredForFrontier(mastery: number, evidenceCount: number): boolean {
  return mastery >= MASTERED_PL_THRESHOLD && evidenceCount >= FRONTIER_MASTERY_MIN_EVIDENCE;
}

/**
 * Cold-start p(L) for a KC with no mastery row, matching the PFA midpoint. Below the
 * mastery threshold, so an unattempted prerequisite keeps its dependents gated.
 */
const COLD_START_PL = 0.5;

type FrontierClosureRow = {
  frontier_kc: string;
  prereq_kc: string;
  depth: number | string;
};

/** Sparse and overflow both produce no ids; only sparse means the graph is still cold. */
export type FrontierKind = 'sparse' | 'dense' | 'overflow';

/** Frontier ids plus the closure that produced them, so callers need not recompute it. */
export interface FrontierResolution {
  kind: FrontierKind;
  ids: string[];
  /** Only populated for `dense`. */
  prereqsByFrontier?: Map<string, string[]>;
}

/**
 * The learnable frontier and why it is empty. `ids` is sorted; sparse and overflow
 * both carry `[]`, so callers that care must read `kind`.
 */
export async function learnableFrontierResolved(db: DbLike): Promise<FrontierResolution> {
  // Recurse one level past the limit and fetch one row past the cap so overflow is
  // detectable without a second query.
  const depthProbe = FRONTIER_DEPTH_LIMIT + 1;
  const fetchLimit = FRONTIER_NODE_CAP + 1;

  // Transitive prerequisite closure. `from -> to` means "from is a prereq of to", so
  // walk upward from each dependent's `to` endpoint. UNION collapses diamond paths;
  // the anchor guard cuts cycles. Self-loops and archived edges never count.
  const rows = await db.execute<FrontierClosureRow>(sql`
    WITH RECURSIVE closure AS (
      SELECT
        e.to_knowledge_id   AS frontier_kc,
        e.from_knowledge_id AS prereq_kc,
        1 AS depth
      FROM knowledge_edge e
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id

      UNION

      SELECT
        c.frontier_kc,
        e.from_knowledge_id AS prereq_kc,
        c.depth + 1 AS depth
      FROM knowledge_edge e
      JOIN closure c ON e.to_knowledge_id = c.prereq_kc
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id
        AND e.from_knowledge_id <> c.frontier_kc
        AND c.depth < ${depthProbe}
    )
    SELECT frontier_kc, prereq_kc, MAX(depth) AS depth
    FROM closure
    GROUP BY frontier_kc, prereq_kc
    LIMIT ${fetchLimit}
  `);

  // Any overflow blanks the frontier; never return a partially walked graph.
  const normalised = rows.map((r) => ({
    frontier_kc: r.frontier_kc,
    prereq_kc: r.prereq_kc,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));
  const depthOverflow = normalised.some((r) => r.depth > FRONTIER_DEPTH_LIMIT);
  const nodeOverflow = normalised.length > FRONTIER_NODE_CAP;
  if (depthOverflow || nodeOverflow) {
    // Warn here so every consumer inherits overflow visibility. No dedup: overflow is
    // a persistent graph condition, so repeated warns are the intended signal.
    console.warn(
      '[frontier] closure overflow — depth/node-cap fail-safe tripped, frontier blanked',
      {
        depthOverflow,
        nodeOverflow,
        depthLimit: FRONTIER_DEPTH_LIMIT,
        nodeCap: FRONTIER_NODE_CAP,
        rows: normalised.length,
        hint: '检查 prerequisite 边:depth 溢出→过深链/上游环(depth>limit);node-cap 溢出→异常扇出。overflow 期间 frontier 全面为空(composer/FrontierRail/nightly 三面)。',
        see: 'docs/design/2026-07-03-frontier-gate-spec.md §Q1',
      },
    );
    return { kind: 'overflow', ids: [] };
  }

  if (normalised.length === 0) return { kind: 'sparse', ids: [] };

  const prereqsByFrontier = new Map<string, string[]>();
  for (const r of normalised) {
    const list = prereqsByFrontier.get(r.frontier_kc) ?? [];
    list.push(r.prereq_kc);
    prereqsByFrontier.set(r.frontier_kc, list);
  }

  // Mastery stays in TS via the canonical projection; the cast is safe because it is a
  // pure read and may run inside the compose transaction.
  const allKcs = new Set<string>();
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    allKcs.add(frontierKc);
    for (const p of prereqKcs) allKcs.add(p);
  }
  const projection = await getMasteryProjection(db as Db, [...allKcs]);
  const pL = (kc: string): number => projection.get(kc)?.mastery ?? COLD_START_PL;
  const evidenceOf = (kc: string): number => projection.get(kc)?.evidence_count ?? 0;
  // Applied to both sides: a prereq that is only "mastered" on lucky answers is as
  // unreliable as a self KC dropped on them.
  const masteredEnough = (kc: string): boolean => isMasteredForFrontier(pL(kc), evidenceOf(kc));

  // Sorted for deterministic output; the caller applies the item cap.
  const frontier: string[] = [];
  for (const [frontierKc, prereqKcs] of prereqsByFrontier) {
    if (masteredEnough(frontierKc)) continue;
    const allPrereqsMastered = prereqKcs.every((p) => masteredEnough(p));
    if (allPrereqsMastered) frontier.push(frontierKc);
  }
  frontier.sort();
  return { kind: 'dense', ids: frontier, prereqsByFrontier };
}

const RELATION_PREREQUISITE = 'prerequisite' as const;

/** Cap on rail items (dense first, then propose). A UI banner, not the full set. */
export const FRONTIER_RAIL_MAX_ITEMS = 8;

/** Scan cap for the banner query; defends against unbounded accumulation, not a business cap. */
const FRONTIER_PROPOSE_SCAN_CAP = 100;

/** Prereq names shown before collapsing to "等 N 项". */
const PROPOSE_REASON_NAME_CAP = 2;

/** Char cap for the LLM reasoning fallback. */
const PROPOSE_LLM_REASON_CAP = 40;

/**
 * One rail card. Band fields are flat so the item can be passed straight to BandChip.
 */
export interface FrontierRailItem {
  kid: string;
  name: string;
  /** Qualitative reason (counts or names, never a probability). */
  reason: string;
  /** True for a cold-start proposed prerequisite suggestion. */
  propose: boolean;
  /** Suggestion-level confidence, distinct from the band's. */
  lowConf: boolean;
  mastery: number | null;
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

/** A pending proposed prerequisite edge plus its reasoning. */
interface PendingPrereqProposal {
  from: string;
  to: string;
  reason: string | null;
}

// Frontier means structurally reachable, not easy or likely correct. Do not add
// difficulty or accuracy wording to these reasons.
/** Every prereq passed the gate, so the count is deterministic. */
function denseReason(prereqCount: number): string {
  return prereqCount > 0 ? `已掌握全部 ${prereqCount} 个前置` : '前置条件为空';
}

/** Names of the unconfirmed prerequisites that suggest this KC. */
function proposeReason(prereqNames: string[], llmReason: string | null): string {
  if (prereqNames.length === 0) {
    // Names can be missing (archived or unknown), so fall back to frontier_fill's
    // reasoning, then to a generic string. Clamp it to keep the card readable.
    if (!llmReason) return 'AI 提议的下一步 · 待确认';
    const clamped =
      llmReason.length > PROPOSE_LLM_REASON_CAP
        ? `${llmReason.slice(0, PROPOSE_LLM_REASON_CAP)}…`
        : llmReason;
    return `AI 提议：${clamped} · 待确认`;
  }
  const shown = prereqNames.slice(0, PROPOSE_REASON_NAME_CAP).join('、');
  const extra = prereqNames.length > PROPOSE_REASON_NAME_CAP ? ` 等 ${prereqNames.length} 项` : '';
  return `AI 提议前置：${shown}${extra} · 待确认`;
}

/** Mastered only with both the p(L) gate and the evidence floor. */
function isMastered(
  entry: { mastery: number | null; evidence_count: number } | undefined,
): boolean {
  return (
    typeof entry?.mastery === 'number' && isMasteredForFrontier(entry.mastery, entry.evidence_count)
  );
}

/**
 * Pending proposed prerequisite edges: propose events with no rate event and no
 * rejected fold. Mirrors loadPendingEdgeProposalKeys but returns full payloads.
 */
async function loadPendingPrereqProposals(db: Db): Promise<PendingPrereqProposal[]> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        eq(event.subject_kind, 'knowledge_edge'),
        // Filter in SQL: only prerequisite proposals, and no terminal rejected fold.
        // Mirrors loadPendingEdgeProposalKeys — keep in sync.
        sql`(${event.payload}->>'relation_type') = ${RELATION_PREREQUISITE}`,
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
        sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
      ),
    )
    // Tiebreak by id: tight proposal loops can share a millisecond, and the item cap
    // must pick deterministically.
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(FRONTIER_PROPOSE_SCAN_CAP);

  if (proposeRows.length === 0) return [];

  // Accept/dismiss writes a chained rate event; a rated proposal is no longer pending.
  const proposeIds = proposeRows.map((r) => r.id);
  const rateRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'knowledge_edge'),
        inArray(event.caused_by_event_id, proposeIds),
      ),
    );
  const rated = new Set(
    rateRows.map((r) => r.caused_by_event_id).filter((id): id is string => id !== null),
  );

  const out: PendingPrereqProposal[] = [];
  for (const row of proposeRows) {
    if (rated.has(row.id)) continue;
    const p = row.payload as {
      from_knowledge_id?: unknown;
      to_knowledge_id?: unknown;
      relation_type?: unknown;
      reasoning?: unknown;
    };
    // Relation type is already filtered; only guard endpoint presence.
    if (typeof p.from_knowledge_id !== 'string' || typeof p.to_knowledge_id !== 'string') continue;
    out.push({
      from: p.from_knowledge_id,
      to: p.to_knowledge_id,
      reason: typeof p.reasoning === 'string' ? p.reasoning : null,
    });
  }
  return out;
}

/** Endpoints that already have a live prerequisite edge. */
async function loadLivePrereqCoveredIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ to: knowledge_edge.to_knowledge_id })
    .from(knowledge_edge)
    .where(
      and(
        eq(knowledge_edge.relation_type, RELATION_PREREQUISITE),
        isNull(knowledge_edge.archived_at),
      ),
    );
  return new Set(rows.map((r) => r.to));
}

/** Names for visible KC ids; archived, unknown and synthetic ids are omitted. */
async function loadKcNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(
      and(
        inArray(knowledge.id, ids),
        isNull(knowledge.archived_at),
        notLike(knowledge.id, 'synthetic:%'),
        notLike(knowledge.id, 'seed:%:root'),
      ),
    );
  return new Map(
    rows.filter((row) => isLearnerVisibleKnowledgeId(row.id)).map((r) => [r.id, r.name]),
  );
}

/**
 * The rail read model. Dense items first, then proposals up to the item cap. An empty
 * result is an honest cold-start state, not a fabricated next step.
 */
export async function loadFrontierRail(db: Db): Promise<FrontierRailItem[]> {
  const resolved = await learnableFrontierResolved(db);
  const denseIds = resolved.kind === 'dense' ? resolved.ids : [];
  const prereqsByFrontier = resolved.prereqsByFrontier ?? new Map<string, string[]>();
  const denseSet = new Set(denseIds);

  const proposals = await loadPendingPrereqProposals(db);
  const proposeByTo = new Map<string, { froms: Set<string>; reason: string | null }>();
  for (const p of proposals) {
    const entry = proposeByTo.get(p.to) ?? { froms: new Set<string>(), reason: null };
    entry.froms.add(p.from);
    if (entry.reason === null && p.reason !== null) entry.reason = p.reason;
    proposeByTo.set(p.to, entry);
  }
  // Keep the propose half genuinely cold-start: drop endpoints already covered by a
  // live edge, so the two halves stay disjoint.
  const liveCovered = await loadLivePrereqCoveredIds(db);
  for (const to of [...proposeByTo.keys()]) {
    if (liveCovered.has(to) || denseSet.has(to)) proposeByTo.delete(to);
  }
  const proposeIds = [...proposeByTo.keys()];

  const surfacedIds = [...denseIds, ...proposeIds];
  const fromIds = new Set<string>();
  for (const entry of proposeByTo.values()) for (const f of entry.froms) fromIds.add(f);
  const nameIds = [...new Set([...surfacedIds, ...fromIds])];

  const [projection, nameById] = await Promise.all([
    getMasteryProjection(db, surfacedIds),
    loadKcNames(db, nameIds),
  ]);

  // Never suggest an already-mastered KC.
  const proposeFinal = proposeIds.filter((id) => !isMastered(projection.get(id)));

  const bandFields = (
    kid: string,
  ): Omit<FrontierRailItem, 'kid' | 'name' | 'reason' | 'propose' | 'lowConf'> => {
    const proj = projection.get(kid);
    return {
      mastery: proj?.mastery ?? null,
      mastery_lo: proj?.mastery_lo ?? null,
      mastery_hi: proj?.mastery_hi ?? null,
      low_confidence: proj?.low_confidence ?? false,
      evidence_count: proj?.evidence_count ?? 0,
    };
  };

  const items: FrontierRailItem[] = [];

  for (const kid of denseIds) {
    const name = nameById.get(kid);
    if (name === undefined) continue;
    items.push({
      kid,
      name,
      reason: denseReason(prereqsByFrontier.get(kid)?.length ?? 0),
      propose: false,
      lowConf: false,
      ...bandFields(kid),
    });
  }

  for (const kid of proposeFinal) {
    const name = nameById.get(kid);
    if (name === undefined) continue;
    const froms = [...(proposeByTo.get(kid)?.froms ?? [])];
    const fromNames = froms.map((f) => nameById.get(f)).filter((n): n is string => n !== undefined);
    items.push({
      kid,
      name,
      reason: proposeReason(fromNames, proposeByTo.get(kid)?.reason ?? null),
      propose: true,
      lowConf: true,
      ...bandFields(kid),
    });
  }

  return items.slice(0, FRONTIER_RAIL_MAX_ITEMS);
}
