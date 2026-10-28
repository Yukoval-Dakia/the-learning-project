// FrontierRail read model. The dense half comes from live prerequisite edges; the
// propose half comes from pending (non-live) proposals and is always tagged as a
// low-confidence suggestion. The two halves never mix: a proposed edge cannot enter
// the live frontier, and reasons/bands stay qualitative rather than raw probabilities.
//
// The shared frontier decision supplies dense ids and prerequisite counts;
// this module owns proposal selection, visibility and rail presentation.

import { and, desc, eq, inArray, isNull, notLike, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import {
  isMasteredForFrontier,
  learnableFrontierResolved,
} from '@/kernel/read-models/learnable-frontier';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';

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
