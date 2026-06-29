// A5 S2 (YUK-354) — FrontierRail read model. Assembles the「下一步，你学得动这些」
// learnable-frontier banner shape from TWO halves:
//
//   - DENSE half (live edges): learnableFrontierResolved(db) `kind==='dense'` ids — KCs
//     whose live (non-archived) prerequisite closure is fully mastered. `propose=false,
//     lowConf=false` (a live edge confidently unlocks them). The "前置已掌握" reason is
//     assembled from the closure surfaced on FrontierResolution.prereqsByFrontier.
//   - PROPOSE half (cold-start, proposed/non-live edges): on a sparse graph the dense
//     frontier is empty; the only "next steps" come from frontier_fill_nightly's
//     PROPOSE-ONLY (low-confidence) prerequisite edges (pending propose events, NOT live
//     knowledge_edge rows). Each pending proposed prereq edge `from→to` suggests `to` as a
//     low-confidence next step. `propose=true, lowConf=true`.
//
// RED LINES (ADR-0035 / ⑥治理):
//   - Three-axis orthogonality: PURE READ. This module never writes any axis.
//   - Proposed edges stay PROPOSE-ONLY: the dense half reads ONLY live edges (via the
//     untouched learnableFrontierResolved), so a proposed edge can never pollute the live
//     frontier. The propose half reads proposed edges SEPARATELY and tags them
//     propose+lowConf — they are surfaced as suggestions, never folded into the live set.
//   - ⑥ governance: reasons + bands are QUALITATIVE (prereq COUNTS / proposed-prereq
//     NAMES + the discrete BandChip), never bare mastery probabilities.

import {
  MASTERED_PL_THRESHOLD,
  learnableFrontierResolved,
} from '@/capabilities/practice/server/learnable-frontier';
import type { Db } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { getMasteryProjection } from '@/server/mastery/state';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

const RELATION_PREREQUISITE = 'prerequisite' as const;

/** Cap on rail items (dense first, then propose). A UI banner, not the full set. */
export const FRONTIER_RAIL_MAX_ITEMS = 8;

/**
 * Scan cap on the pending-propose-edge query (OCR). This feeds a ≤8-item UI banner — unlike
 * loadPendingEdgeProposalKeys it does NOT need the full cross-batch dedup set. frontier_fill
 * caps proposals/run and dedups pending pairs, so a mature graph stays well under this; the
 * LIMIT is degenerate-defense against unbounded accumulation, not a business cap.
 */
const FRONTIER_PROPOSE_SCAN_CAP = 100;

/** Proposed-prereq NAMES shown verbatim in a propose reason before collapsing to "等 N 项". */
const PROPOSE_REASON_NAME_CAP = 2;

/** Char cap for the LLM-`reasoning` fallback shown when no prereq names survive. */
const PROPOSE_LLM_REASON_CAP = 40;

/**
 * One FrontierRail card. The mastery-band fields ({@link MasteryBandInput} shape:
 * `mastery` / `mastery_lo` / `mastery_hi` / `low_confidence` / `evidence_count`) are
 * spread FLAT so the UI can pass the whole item straight to `<BandChip input={item} />`
 * (structural subtyping — same wiring KnowledgePage uses for tree rows).
 */
export interface FrontierRailItem {
  kid: string;
  name: string;
  /** Qualitative "why you can learn this" string (counts / names — never a probability). */
  reason: string;
  /** true → a cold-start PROPOSED (non-live) prerequisite suggestion ("建议·低置信"). */
  propose: boolean;
  /** Suggestion-level low-confidence flag (set with `propose`); distinct from the band's. */
  lowConf: boolean;
  // ── mastery-band fields (MasteryBandInput) — consumed by BandChip ──
  mastery: number | null;
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

/** A pending (unrated, non-folded) proposed prerequisite edge `from→to` + its reasoning. */
interface PendingPrereqProposal {
  from: string;
  to: string;
  reason: string | null;
}

/** Dense-half reason: every prereq is mastered by the gate, so it is a deterministic count. */
function denseReason(prereqCount: number): string {
  return prereqCount > 0 ? `已掌握全部 ${prereqCount} 个前置` : '前置已满足';
}

/** Propose-half reason: the proposed (unconfirmed) prerequisite NAMES that suggest this KC. */
function proposeReason(prereqNames: string[], llmReason: string | null): string {
  if (prereqNames.length === 0) {
    // 前置名全缺席（归档/未知）→ 回落 frontier_fill 写的 LLM reasoning（更有信息量，消死字段，
    // reviewer minor），它也缺才用泛化串。clamp 防过长撑卡。
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

/** A KC counts as mastered iff it has a projection row at/above the frontier threshold. */
function isMastered(mastery: number | null | undefined): boolean {
  return typeof mastery === 'number' && mastery >= MASTERED_PL_THRESHOLD;
}

/**
 * Pending PROPOSED prerequisite edges — propose events for knowledge_edge with no chained
 * `rate` (accept/dismiss) and not folded (rubric/topology rejected). Mirrors
 * loadPendingEdgeProposalKeys' filters (propose_edge.ts) but returns full payloads (from /
 * to / reasoning) and narrows to `relation_type='prerequisite'`. Pure READ.
 */
async function loadPendingPrereqProposals(db: Db): Promise<PendingPrereqProposal[]> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        eq(event.subject_kind, 'knowledge_edge'),
        // SQL-filter to prerequisite up front (relation_type is flattened to the top-level
        // event payload by eventShapeForProposal's knowledge_edge case) → load ONLY prereq
        // proposals, not ALL knowledge_edge proposals then JS-filter (OCR perf).
        sql`(${event.payload}->>'relation_type') = ${RELATION_PREREQUISITE}`,
        // Exclude rubric-rejected / topology-rejected FOLDS (terminal, not live-pending).
        // These mirror loadPendingEdgeProposalKeys (propose_edge.ts, RB-7 / ADR-0034 §2) —
        // KEEP IN SYNC. follow-up (OCR): extract a shared predicate helper to prevent drift.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
        sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
      ),
    )
    // 次级 tiebreaker desc(event.id)：frontier_fill 紧循环多个 writeAiProposal 可撞 ms
    // （本仓库刚为 ms-collision flake 加固过 qb 测），无 tiebreaker 则 >8-cap 时「哪 8 个显示」
    // 非确定（reviewer nit）。
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(FRONTIER_PROPOSE_SCAN_CAP);

  if (proposeRows.length === 0) return [];

  // Drop proposals already decided (an accept/dismiss writes a `rate` event chained via
  // caused_by_event_id) — an accepted edge becomes LIVE (excluded again downstream).
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
    // relation_type already SQL-filtered to prerequisite above; just guard from/to presence.
    if (typeof p.from_knowledge_id !== 'string' || typeof p.to_knowledge_id !== 'string') continue;
    out.push({
      from: p.from_knowledge_id,
      to: p.to_knowledge_id,
      reason: typeof p.reasoning === 'string' ? p.reasoning : null,
    });
  }
  return out;
}

/** `to_knowledge_id`s that already have a LIVE (non-archived) prerequisite edge. */
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

/** Names for non-archived KC ids (archived/unknown ids are absent → caller drops them). */
async function loadKcNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(inArray(knowledge.id, ids), isNull(knowledge.archived_at)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * loadFrontierRail — the FrontierRail read model. Pure READ; see the RED LINES header.
 *
 * Dense items take priority; propose items fill remaining slots up to
 * {@link FRONTIER_RAIL_MAX_ITEMS}. Returns [] on a fully cold-start graph with no pending
 * proposals (the UI renders an honest empty state, not a fabricated next step).
 */
export async function loadFrontierRail(db: Db): Promise<FrontierRailItem[]> {
  // ── DENSE half — live prereq-gated frontier (untouched live-only computation) ──
  const resolved = await learnableFrontierResolved(db);
  const denseIds = resolved.kind === 'dense' ? resolved.ids : [];
  const prereqsByFrontier = resolved.prereqsByFrontier ?? new Map<string, string[]>();
  const denseSet = new Set(denseIds);

  // ── PROPOSE half — cold-start proposed (non-live) prereq edges → suggested next steps ──
  const proposals = await loadPendingPrereqProposals(db);
  const proposeByTo = new Map<string, { froms: Set<string>; reason: string | null }>();
  for (const p of proposals) {
    const entry = proposeByTo.get(p.to) ?? { froms: new Set<string>(), reason: null };
    entry.froms.add(p.from);
    if (entry.reason === null && p.reason !== null) entry.reason = p.reason;
    proposeByTo.set(p.to, entry);
  }
  // Keep the propose half to TRUE cold-start KCs: drop any `to` already covered by a live
  // prereq edge (it is either in the dense frontier or gated out of it — not a cold-start
  // suggestion). This reconstructs frontier_fill_nightly's candidate set (KCs lacking live
  // prereq coverage) and keeps proposed/live halves disjoint.
  const liveCovered = await loadLivePrereqCoveredIds(db);
  for (const to of [...proposeByTo.keys()]) {
    if (liveCovered.has(to) || denseSet.has(to)) proposeByTo.delete(to);
  }
  const proposeIds = [...proposeByTo.keys()];

  // ── bands (BandChip) + names, batched once over both halves ──
  const surfacedIds = [...denseIds, ...proposeIds];
  const fromIds = new Set<string>();
  for (const entry of proposeByTo.values()) for (const f of entry.froms) fromIds.add(f);
  const nameIds = [...new Set([...surfacedIds, ...fromIds])];

  const [projection, nameById] = await Promise.all([
    getMasteryProjection(db, surfacedIds),
    loadKcNames(db, nameIds),
  ]);

  // self-not-mastered gate for propose candidates (never suggest an already-mastered KC).
  const proposeFinal = proposeIds.filter((id) => !isMastered(projection.get(id)?.mastery));

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
    if (name === undefined) continue; // archived / unknown KC → drop silently.
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
