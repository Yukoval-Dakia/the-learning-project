// P5.4 / YUK-143 — Proposal Quality Rubric Enforcement, Layer 1.
//
// Spec: docs/superpowers/specs/2026-05-31-p5.4-rubric-enforcement-design.md
// Source of truth for the gates: docs/modules/knowledge.md §4
//   §4.1 universal structural gates (G1–G7), §4.2 evidence levels,
//   §4.3 relation-specific gates.
//
// This is the single shared validator (RB-1) called by BOTH agent proposal
// write paths before writeAiProposal:
//   - DomainTool  proposeKnowledgeEdgeExecute  (proposal-tools.ts)
//   - legacy MCP  writeProposalAfterGate       (review.ts)
// so neither bypasses the floor.
//
// Layer 1 is DETERMINISTIC — no LLM call. It computes the §4.2 evidence level
// from the proposal's evidence_refs (recency + judge-backed) and applies the
// §4.3 relation predicates with cheap heuristics. The adaptive accept-learned
// bias (downweighting medium evidence, reading proposal_signals) is Layer 2 /
// YUK-174 — intentionally NOT here (RB-4 / §6 non-goals).
//
// Verdict shape is STABLE for YUK-174 (RB-9): { ok:true } | { ok:false; gate; reason }.

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { assertKnowledgeIdsExist } from '@/capabilities/knowledge/server/validate';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import {
  type EffectiveFailureCause,
  effectiveCauseForFailureAttempt,
} from '@/server/events/cause-policy';
import { type FailureAttempt, getFailureAttemptById } from '@/server/events/queries';
// P5.4-L2 / YUK-174 — OPTIONAL adaptive gate input (Facet B). Type-only import:
// the validator stays PURE (it does NOT run adaptive-bias.ts at runtime — the
// import erases). The gate-bump decision + its audit metadata are COMPUTED by
// adaptive-bias.ts at the call site and carried IN, so the folded reject reason
// can cite the rate/threshold/sample without re-reading the signal (§3.4).
import type { AdaptiveGateInput } from '@/server/proposals/adaptive-bias';
import { eq } from 'drizzle-orm';

// RB-5 — single-source evidence window. Consumed by the recency check (RB-4)
// and the §4.2 level computation. knowledge.md §4.2 "recent window: 30 days".
export const RUBRIC_EVIDENCE_WINDOW_DAYS = 30;

const RUBRIC_EVIDENCE_WINDOW_MS = RUBRIC_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

type DbLike = Db | Tx;

// The stable `gate` string set (spec §3.4). YUK-174 depends on this enum.
export type RubricGate =
  | 'self_edge'
  | 'unknown_node'
  | 'cross_subject'
  | 'parent_semantic_duplicate'
  | 'duplicate_live_edge'
  | 'duplicate_pending'
  | 'reasoning_generic'
  | 'evidence_missing'
  | 'evidence_level'
  | 'prerequisite_no_order_evidence'
  | 'contrasts_with_no_confusion'
  | 'applied_in_role_mismatch'
  | 'related_to_dumping_ground'
  // derived_from (and the experimental default) must still have ≥1 in-window
  // judge-backed failure referencing an endpoint — mirrors the endpoint-touching
  // requirement of the other §4.3 relations so a derived_from edge cannot pass
  // on 2 unrelated same-cause failures that touch neither node.
  | 'derived_from_no_endpoint_evidence';

export type RubricVerdict = { ok: true } | { ok: false; gate: RubricGate; reason: string };

export interface RubricValidatorCtx {
  isAgent: boolean;
  actorRef: string;
}

// §4.4 — reasoning must be concrete. The G7a reasoning-depth gate is a cheap
// deterministic heuristic (NOT an LLM call): reject reason_md that either
// matches a generic-phrase denylist or names no concrete signal (event id,
// node id, or a cause-category-ish token). Tuned against the §4.4 bad example
// "这两个知识点都和"之"有关，容易混淆。".
const GENERIC_PHRASE_DENYLIST = [
  '二者相关',
  '两者相关',
  '比较相关',
  '都和',
  '有关联',
  '容易混淆', // only generic when no concrete signal is present (see below)
  'related',
  'they are related',
  'seem related',
];

// A "concrete signal" is any of: a referenced id token (looks like an id with
// an underscore/prefix or a long token), an explicit attempt/event/judge
// reference, or a wenyan-style 知识点 name in 「」 quotes. Deliberately loose —
// the goal is to reject empty filler, not to gate genuine prose.
function namesConcreteSignal(reason: string): boolean {
  // id-ish token: prefix_xxx (k_, e_, att_, q_, judge_, attempt_event_...)
  if (/[a-z]+_[a-z0-9_]+/i.test(reason)) return true;
  // explicit reference vocabulary
  if (/(attempt|judge|cause|event|失败|错题|attempt_event|judge cause)/i.test(reason)) return true;
  // 「…」 quoted knowledge node name (wenyan §4.4 good example)
  if (/[「『][^」』]+[」』]/.test(reason)) return true;
  return false;
}

function reasoningIsGeneric(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  const hitsDenylist = GENERIC_PHRASE_DENYLIST.some((phrase) =>
    lower.includes(phrase.toLowerCase()),
  );
  const concrete = namesConcreteSignal(trimmed);
  // Generic when: it matches a denylist phrase AND names no concrete signal,
  // or it is very short with no concrete signal at all.
  if (concrete) return false;
  if (hitsDenylist) return true;
  // No concrete signal and short → filler ("二者相关").
  return trimmed.length < 12;
}

// P5.4-L2 — format a carried acceptance_rate / threshold for the adaptive reject
// reason (codex#2). Pure string formatting from the carried AdaptiveGateInput
// fields; the validator does not re-read the signal.
function formatRate(value: number | undefined): string {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}

type EdgePayload = Extract<AiProposalPayloadT, { kind: 'knowledge_edge' }>;

function isEdgePayload(payload: AiProposalPayloadT): payload is EdgePayload {
  return payload.kind === 'knowledge_edge';
}

function evidenceEventIds(payload: EdgePayload): string[] {
  return payload.evidence_refs.filter((ref) => ref.kind === 'event').map((ref) => ref.id);
}

interface ResolvedEvidence {
  attempt: FailureAttempt;
  cause: EffectiveFailureCause | null;
  inWindow: boolean;
  judgeBacked: boolean;
  hasExplicitJudgeAnalysis: boolean;
}

async function resolveEvidence(
  db: DbLike,
  eventIds: string[],
  now: number,
): Promise<ResolvedEvidence[]> {
  const out: ResolvedEvidence[] = [];
  for (const id of [...new Set(eventIds)]) {
    const attempt = await getFailureAttemptById(db, id);
    if (!attempt) continue; // not a live failure attempt — not usable evidence
    const cause = effectiveCauseForFailureAttempt(attempt);
    // RB-5 / §4.2: recency anchor is the ATTEMPT timestamp, not the judge run.
    const inWindow = now - attempt.created_at.getTime() <= RUBRIC_EVIDENCE_WINDOW_MS;
    // "judge-backed" (§5 Q4): reuse the existing cause resolver. user_cause is
    // authoritative over agent judge (cause-policy); either an active judge
    // (source 'agent') or an active user_cause (source 'user') counts as the
    // §4.2 "clear judge analysis" backing for the failure.
    //
    // NOTE (§5 Q4, deliberate): `effectiveCauseForFailureAttempt` returns
    // non-null even for a user_cause-only attempt that carries NO analysis text
    // (the user tagged a category without writing notes). That is an intentional
    // §5 Q4 reuse of the existing cause resolver, NOT an oversight: a user
    // categorising a failure IS authoritative backing under cause-policy, and
    // the stricter "has prose" check is surfaced separately as
    // `hasExplicitJudgeAnalysis` (used by the prerequisite/contrasts_with
    // 2-event relaxation), not folded into the judge-backed floor.
    const judgeBacked = cause !== null;
    const hasExplicitJudgeAnalysis =
      attempt.judge !== undefined &&
      typeof attempt.judge.cause.analysis_md === 'string' &&
      attempt.judge.cause.analysis_md.trim().length > 0;
    out.push({ attempt, cause, inWindow, judgeBacked, hasExplicitJudgeAnalysis });
  }
  return out;
}

// Effective referenced-knowledge set for an evidence event = the ids the
// ATTEMPT referenced UNION the ids the JUDGE referenced at grading time
// (codex r4 P2 #3). `attempt.referenced_knowledge_ids` is the (possibly stale or
// empty) user selection on the attempt; `attempt.judge.referenced_knowledge_ids`
// is what the judge actually pointed at. A prerequisite / contrasts_with /
// applied_in / derived_from proposal whose JUDGE references an endpoint (but the
// attempt's own refs are empty) was wrongly folded as no-endpoint / no-confusion
// evidence. Merging is strictly ADDITIVE — it only makes MORE refs count, never
// loosens the leveling or the relation-scoping (the endpoint requirement must
// still be MET; it is just now also satisfiable via judge refs). Used by the
// same-pattern overlap (hasSamePatternPair) and the endpoint / confusion checks.
function effectiveReferencedKnowledgeIds(ev: ResolvedEvidence): string[] {
  const attemptRefs = ev.attempt.referenced_knowledge_ids;
  const judgeRefs = ev.attempt.judge?.referenced_knowledge_ids ?? [];
  if (judgeRefs.length === 0) return attemptRefs;
  return [...new Set([...attemptRefs, ...judgeRefs])];
}

type EvidenceLevel = 'strong' | 'medium' | 'weak';

// §4.2 "strong = 2+ recent failure events show SAME PATTERN" (spec §3.2, line
// 150). Raw count is not enough: two UNRELATED judge-backed failures must not
// upgrade to strong (a low-quality edge would otherwise pass the relation gate).
// Two events are "same pattern" when they are consistent on EITHER axis:
//   - cause: they share the effective failure cause `primary_category`, OR
//   - referenced knowledge: they overlap on at least one referenced node id.
// We require a pair (i,j) within the usable set that is consistent on at least
// one axis. With ≥2 usable events this is the predicate that distinguishes
// "2 failures about the same thing" (strong) from "2 incidental failures"
// (at most medium → rejected for agents, RB-4).
function hasSamePatternPair(usable: ResolvedEvidence[]): boolean {
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      const sameCause =
        a.cause !== null &&
        b.cause !== null &&
        a.cause.primary_category === b.cause.primary_category;
      if (sameCause) return true;
      // Overlap uses the effective refs (attempt ∪ judge) so a shared
      // judge-referenced node counts as same-pattern even when the attempt's
      // own refs are empty/stale (codex r4 P2 #3).
      const aRefs = new Set(effectiveReferencedKnowledgeIds(a));
      const sharesKnowledge = effectiveReferencedKnowledgeIds(b).some((kid) => aRefs.has(kid));
      if (sharesKnowledge) return true;
    }
  }
  return false;
}

// §4.2 level computation from the in-window, judge-backed evidence set.
//   strong: 2+ in-window judge-backed failures that show the SAME PATTERN
//           (shared cause category OR overlapping referenced knowledge), OR
//           1 failure + explicit user note
//   medium: exactly 1 in-window judge-backed failure, OR 2+ that are unrelated
//           (no same-pattern pair) — agents are rejected at medium (RB-4)
//   weak:   0 usable failures
function computeEvidenceLevel(usable: ResolvedEvidence[]): EvidenceLevel {
  const count = usable.length;
  if (count >= 2) {
    // Raw count alone is NOT strong — the ≥2 events must be same-pattern (§4.2).
    // Two unrelated judge-backed failures yield at most medium.
    return hasSamePatternPair(usable) ? 'strong' : 'medium';
  }
  if (count === 1) {
    // §4.2 "1 failure plus explicit user note" → strong.
    const onlyOne = usable[0];
    if (onlyOne.attempt.user_cause && (onlyOne.attempt.user_cause.user_notes ?? '').trim()) {
      return 'strong';
    }
    return 'medium';
  }
  return 'weak';
}

function relationRequiresTwoEvents(relationType: string): boolean {
  return relationType === 'prerequisite' || relationType === 'contrasts_with';
}

// §4.2 + §4.3 "2 events for prerequisite / contrasts_with UNLESS judge analysis
// is explicit". The relaxing basis: ≥1 usable (in-window, judge-backed) failure
// that carries EXPLICIT analysis on EITHER axis — agent judge `analysis_md`
// (hasExplicitJudgeAnalysis) OR a non-empty user_cause.user_notes (§4.2's
// "1 failure + explicit user note" is just as strong as "1 + explicit judge
// analysis"). A single PLAIN failure (cause category tagged but no prose, no
// note) does NOT qualify — it stays the §4.2 medium that needs a second event.
function hasExplicitSingleEventBasis(usable: ResolvedEvidence[]): boolean {
  return usable.some(
    (ev) =>
      ev.hasExplicitJudgeAnalysis || (ev.attempt.user_cause?.user_notes ?? '').trim().length > 0,
  );
}

// §4.3 relation-specific predicates (agents only). Each returns a rejection
// reason string, or null if the relation predicate passes. Layer 1 keeps these
// strict-but-cheap (§5 Q1) — no LLM call.
function relationGate(
  payload: EdgePayload,
  usable: ResolvedEvidence[],
): { gate: RubricGate; reason: string } | null {
  const change = payload.proposed_change;
  const relation = change.relation_type;
  const endpoints = new Set([change.from_knowledge_id, change.to_knowledge_id]);

  // How many in-window judge-backed failures actually reference an endpoint of
  // this edge (the "evidence touches both nodes" / order-evidence signal). The
  // effective refs (attempt ∪ judge) count, so a judge-referenced endpoint
  // satisfies the requirement even when the attempt's own refs are empty/stale
  // (codex r4 P2 #3) — strictly additive, the endpoint must still be MET.
  const referencingEndpoint = usable.filter((ev) =>
    effectiveReferencedKnowledgeIds(ev).some((kid) => endpoints.has(kid)),
  );
  const referencingBoth = usable.filter((ev) => {
    const refs = new Set(effectiveReferencedKnowledgeIds(ev));
    return refs.has(change.from_knowledge_id) && refs.has(change.to_knowledge_id);
  });

  switch (relation) {
    case 'prerequisite': {
      // Require learning-order evidence: at least one in-window judge-backed
      // failure must reference an endpoint. "Do not propose on mere co-occurrence."
      if (referencingEndpoint.length === 0) {
        return {
          gate: 'prerequisite_no_order_evidence',
          reason:
            'prerequisite requires learning-order evidence: no in-window judge-backed failure references either endpoint node (mere co-occurrence is not enough)',
        };
      }
      return null;
    }
    case 'contrasts_with': {
      // Require confusion evidence: a failure that references BOTH endpoints
      // (the same answer confuses both). Same-name siblings with zero confusion
      // evidence → reject (the wenyan overuse risk, §4.3 / §5 Q5).
      if (referencingBoth.length === 0) {
        return {
          gate: 'contrasts_with_no_confusion',
          reason:
            'contrasts_with requires confusion evidence: no in-window judge-backed failure references both endpoint nodes (similarity alone is not confusion)',
        };
      }
      return null;
    }
    case 'applied_in': {
      // Require role compatibility: concept/method → application/assessment.
      // Layer 1 cannot read node roles deterministically, so the cheap proxy is
      // direction + endpoint-referencing evidence: at least one in-window
      // judge-backed failure must reference an endpoint, AND the edge must be
      // directional (from !== to already guaranteed by G1). A self-referential
      // both-ends-same-family edge with no application evidence is rejected.
      if (referencingEndpoint.length === 0) {
        return {
          gate: 'applied_in_role_mismatch',
          reason:
            'applied_in requires concept/method → application/assessment role evidence: no in-window judge-backed failure references either endpoint node',
        };
      }
      return null;
    }
    case 'related_to': {
      // Conservative weak edge only; "more than co-occurrence". Penalize as a
      // dumping ground: require at least one in-window judge-backed failure
      // referencing an endpoint (navigation/grouping value), not a bare guess.
      if (referencingEndpoint.length === 0) {
        return {
          gate: 'related_to_dumping_ground',
          reason:
            'related_to must add navigation/grouping value beyond co-occurrence: no in-window judge-backed failure references either endpoint node',
        };
      }
      return null;
    }
    default:
      // derived_from (and any experimental:* relation that falls here) keeps its
      // structural G6 tree-ancestry check, but must ALSO show usable evidence
      // that touches the edge: require ≥1 in-window judge-backed failure
      // referencing an endpoint. Without this the default branch verified no
      // endpoint-touching evidence at all, so a derived_from edge could pass on
      // 2 unrelated same-cause failures referencing neither node (the strong-
      // via-shared-cause path) — the bypass codex flagged. Mirrors the
      // endpoint-touching requirement the other relations enforce.
      if (referencingEndpoint.length === 0) {
        return {
          gate: 'derived_from_no_endpoint_evidence',
          reason:
            'derived_from requires evidence touching the edge: no in-window judge-backed failure references either endpoint node (shared-cause failures that touch neither node are not enough)',
        };
      }
      return null;
  }
}

// G6 (generalized) — reject an edge that merely restates an existing tree
// parent/child (ancestor/descendant) relation with no new semantics. Covers
// §4.3 derived_from "reject if already tree ancestor/descendant" and the
// related_to parent-only case. Walks up to MAX_DEPTH from each endpoint.
const G6_MAX_DEPTH = 32;

async function restatesTreeAncestry(db: DbLike, fromId: string, toId: string): Promise<boolean> {
  const isAncestor = async (childId: string, ancestorId: string): Promise<boolean> => {
    let cur: string | null = childId;
    for (let depth = 0; depth < G6_MAX_DEPTH; depth++) {
      if (cur === null) return false;
      const rows: Array<{ parent_id: string | null }> = await db
        .select({ parent_id: knowledge.parent_id })
        .from(knowledge)
        .where(eq(knowledge.id, cur))
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      if (row.parent_id === ancestorId) return true;
      cur = row.parent_id;
    }
    return false;
  };
  return (await isAncestor(fromId, toId)) || (await isAncestor(toId, fromId));
}

/**
 * P5.4 Layer-1 proposal quality rubric (RB-1). Returns a structured verdict.
 *
 * Agents (ctx.isAgent === true): runs §4.1 structural (G1–G6) + §4.1 G7a
 * reasoning-depth + the §4.2 evidence floor (RB-4: evidence non-empty, ≥1
 * in-window judge-backed event, level computed, REJECT medium/weak) + the §4.3
 * relation predicates.
 *
 * User-edited proposals (ctx.isAgent === false, RB-3): runs ONLY the §4.1
 * structural class (G1–G6); skips reasoning-depth, evidence floor, and relation
 * gates. (Forward-looking — no user-edit-then-propose path exists today, §1.)
 *
 * Non-edge proposal kinds are out of scope for P5.4's two call sites and return
 * { ok:true } (they do not flow through this validator's edge-specific gates).
 */
export async function validateProposalQuality(
  payload: AiProposalPayloadT,
  db: DbLike,
  ctx: RubricValidatorCtx,
  // P5.4-L2 / YUK-174 (Facet B / AB-3) — OPTIONAL adaptive gate input. Omitted →
  // byte-identical to pure L1 (the regression invariant, §8). When present with
  // `tightenMediumToStrong: true` it ONLY suppresses the §4.2 explicit-single-
  // event rescue (raise medium/rescue → strong); it NEVER loosens an L1 reject,
  // NEVER blocks `strong` evidence, and adds NO new RubricGate string.
  adaptive?: AdaptiveGateInput,
): Promise<RubricVerdict> {
  if (!isEdgePayload(payload)) {
    return { ok: true };
  }
  const change = payload.proposed_change;
  const fromId = change.from_knowledge_id;
  const toId = change.to_knowledge_id;

  // ADR-0032 D4-E1 (YUK-203) — ARCHIVE edge proposals are the inverse of CREATE:
  // the §4.1 G6 tree-ancestry-restate gate, §4.1 G7a reasoning-depth, the §4.2
  // failure-evidence floor, and the §4.3 relation predicates are all CREATE
  // semantics (they justify ADDING a new edge from observed failures). An archive
  // proposal removes an already-live edge, so it carries no failure evidence by
  // design and must NOT be folded for `evidence_missing`. The structural class
  // that still matters (same-subject endpoints) is re-asserted at the accept
  // applier against the live edge; here we accept the archive proposal so it can
  // reach the inbox. Self-edge is impossible for a live edge (createKnowledgeEdge
  // already rejected it), but we keep the cheap guard for shape stability.
  if (change.edge_op === 'archive') {
    if (fromId === toId) {
      return { ok: false, gate: 'self_edge', reason: 'from_knowledge_id equals to_knowledge_id' };
    }
    return { ok: true };
  }

  // ---- §4.1 structural class (G1–G6) — runs for agents AND users (RB-3) ----

  // G1 — self edge.
  if (fromId === toId) {
    return { ok: false, gate: 'self_edge', reason: 'from_knowledge_id equals to_knowledge_id' };
  }

  // G2 — both nodes exist + are active.
  const exist = await assertKnowledgeIdsExist(db as Db, [fromId, toId]);
  if (!exist.ok) {
    return {
      ok: false,
      gate: 'unknown_node',
      reason: `knowledge node missing or archived: ${exist.missing.join(',')}`,
    };
  }

  // G3 — same subject. getEffectiveDomain is typed for Db but is read-only and
  // runtime-compatible with a Tx; cast keeps the validator usable from the
  // legacy MCP transaction path (review.ts writeProposalAfterGate).
  const [fromDomain, toDomain] = await Promise.all([
    getEffectiveDomain(db as Db, fromId),
    getEffectiveDomain(db as Db, toId),
  ]);
  if (fromDomain !== toDomain) {
    return {
      ok: false,
      gate: 'cross_subject',
      reason: 'knowledge nodes resolve to different subjects',
    };
  }

  // G6 — proposal merely restates existing tree ancestry. SCOPED to relations
  // whose semantics ARE merely hierarchy: `related_to` (the pre-P5.4 inline
  // gate was correctly related_to-only) and `derived_from` (§3.1 / §4.3
  // "reject if already tree ancestor/descendant WITH NO NEW SEMANTICS").
  //
  // It MUST NOT fire for `prerequisite` / `applied_in` / `contrasts_with`:
  // §3.3 explicitly endorses hierarchy-aligned prerequisite (parent concept →
  // child task) and applied_in (concept/method → application) edges, which are
  // valid precisely BECAUSE one endpoint is the other's ancestor. Their own
  // §4.3 relation gates (below) carry the semantic check; gating them here on
  // tree-adjacency would be a false positive. G6 stays structural (runs for
  // agents AND users) for the two hierarchy-only relations.
  const g6Applies =
    change.relation_type === 'related_to' || change.relation_type === 'derived_from';
  if (g6Applies && (await restatesTreeAncestry(db, fromId, toId))) {
    return {
      ok: false,
      gate: 'parent_semantic_duplicate',
      reason: 'edge only restates an existing tree parent/child relationship',
    };
  }

  // (G4 duplicate_live_edge and G5 duplicate_pending are enforced as
  // short-circuit dedup no-ops at each call site BEFORE the validator runs, and
  // re-asserting them here would require duplicating the symmetric-aware edge
  // query + the live-pending derivation. They keep their existing behavior; the
  // gate strings remain in RubricGate for verdict-shape stability / YUK-174.)

  // User-edited proposals stop here (RB-3): structural-only.
  if (!ctx.isAgent) {
    return { ok: true };
  }

  // ---- §4.1 G7a — reasoning depth (agents) ----
  if (reasoningIsGeneric(payload.reason_md)) {
    return {
      ok: false,
      gate: 'reasoning_generic',
      reason:
        'reasoning is generic with no concrete signal (no referenced event id / node / cause); see knowledge.md §4.4',
    };
  }

  // ---- §4.1 G7b + §4.2 evidence floor (agents only, RB-4) ----
  const eventIds = evidenceEventIds(payload);
  if (eventIds.length === 0) {
    return {
      ok: false,
      gate: 'evidence_missing',
      reason: 'agent edge proposal carries no evidence_event_ids',
    };
  }

  const now = Date.now();
  const resolved = await resolveEvidence(db, eventIds, now);
  const usable = resolved.filter((ev) => ev.inWindow && ev.judgeBacked);
  const level = computeEvidenceLevel(usable);
  const requiresTwoEvents = relationRequiresTwoEvents(change.relation_type);

  // §4.3 single-event relaxation for prerequisite / contrasts_with. knowledge.md
  // §4.2 leaves a SINGLE in-window judge-backed failure at `medium` (1 failure
  // with clear judge analysis, NOT a user note → not the strong path) — but
  // §4.2 + §4.3 also say "2 events for prerequisite / contrasts_with UNLESS judge
  // analysis is explicit". For those two relations a single failure WITH explicit
  // analysis (judge analysis_md OR user_cause.user_notes) is exactly the
  // documented exception. We compute the rescue HERE so it is visible to the
  // evidence floor below: without it the floor (RB-4 rejects medium) fired first
  // and the §4.3 relaxation was dead — every single-judge-event prerequisite /
  // contrasts_with proposal was wrongly folded (codex P2, round 3).
  //
  // The rescue is RELATION-SCOPED (only these two relations) and EXPLICIT-ANALYSIS
  // GATED (a single PLAIN failure is NOT rescued). It does NOT touch
  // computeEvidenceLevel's leveling: the event stays `medium` (so OTHER relations
  // with 1 judge event still reject at the floor — no loosening). Endpoint-
  // touching is still required and is enforced by the §4.3 relationGate below.
  // The `usable.length === 1` bound is load-bearing: computeEvidenceLevel also
  // returns `medium` for 2+ UNRELATED judge-backed failures (no same-pattern
  // pair). Without the bound, TWO unrelated events where ONE carries explicit
  // analysis would wrongly take the SINGLE-event rescue and skip the floor
  // (CodeRabbit C5). The §4.3 relaxation is a SINGLE-event exception only.
  const explicitSingleEventRescueBasis =
    requiresTwoEvents &&
    usable.length === 1 &&
    level === 'medium' &&
    hasExplicitSingleEventBasis(usable);

  // P5.4-L2 / YUK-174 (Facet B / B1, tighten-only) — when the adaptive input
  // says to raise the bar for this `(kind, relation)` (low acceptance_rate with
  // enough samples, computeGateBump), SUPPRESS the explicit-single-event rescue
  // so the borderline case requires a genuine `strong` instead. This is the ONLY
  // place L2 touches L1: it can only turn a would-PASS (the rescue path) into a
  // reject. `strong` evidence never reaches this rescue branch, so the bump can
  // never block strong (never locks); cold-start / below-minSamples / above-
  // threshold leaves `adaptive.tightenMediumToStrong === false` → rescue intact
  // (pure L1).
  const adaptiveTighten = adaptive?.tightenMediumToStrong === true;
  const explicitSingleEventRescue = explicitSingleEventRescueBasis && !adaptiveTighten;

  // RB-4 — agents are rejected at medium/weak; only strong writes (plus the
  // §4.3 explicit-single-event rescue above for prerequisite / contrasts_with,
  // unless L2's adaptive bump suppressed it).
  if (level !== 'strong' && !explicitSingleEventRescue) {
    // L2-annotate the reason ONLY when the bump is what removed an otherwise-
    // available rescue (traceability §8). The validator formats this from the
    // CARRIED fields — it never imports adaptive-bias.ts. Gate stays
    // 'evidence_level' (no new RubricGate, RB-9).
    if (adaptiveTighten && explicitSingleEventRescueBasis) {
      return {
        ok: false,
        gate: 'evidence_level',
        reason: `evidence level '${level}': adaptive bias raised the bar for this relation (acceptance_rate ${formatRate(adaptive?.acceptanceRate)} over ${adaptive?.sampleCount ?? 0} decisions, below threshold ${formatRate(adaptive?.threshold)}) — the borderline single-event rescue is suppressed; strong evidence (≥2 in-window judge-backed failures) required`,
      };
    }
    return {
      ok: false,
      gate: 'evidence_level',
      reason: `evidence level '${level}': agent edge requires strong evidence (≥2 in-window judge-backed failures, or 1 + explicit user note) within ${RUBRIC_EVIDENCE_WINDOW_DAYS}d`,
    };
  }

  // §4.2 + §4.3 — prerequisite / contrasts_with require 2 events UNLESS one has
  // explicit analysis. A `strong` level already means ≥2 usable (or 1 + user
  // note, which is itself explicit); when level is `medium` we only reached here
  // via the explicitSingleEventRescue above, so the explicit-analysis basis is
  // already established. The remaining guard: a `strong` level reached WITHOUT
  // the relaxation must still satisfy the ≥2-or-explicit minimum (e.g. a future
  // single-event strong path that is NOT user-note-backed would be caught here).
  if (requiresTwoEvents && usable.length < 2 && !hasExplicitSingleEventBasis(usable)) {
    return {
      ok: false,
      gate: 'evidence_level',
      reason: `${change.relation_type} requires 2 in-window judge-backed failures unless one has explicit judge analysis`,
    };
  }

  // ---- §4.3 relation-specific predicates (agents) ----
  const relationVerdict = relationGate(payload, usable);
  if (relationVerdict) {
    return { ok: false, gate: relationVerdict.gate, reason: relationVerdict.reason };
  }

  return { ok: true };
}
