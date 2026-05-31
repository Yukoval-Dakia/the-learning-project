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

import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import {
  type EffectiveFailureCause,
  effectiveCauseForFailureAttempt,
} from '@/server/events/cause-policy';
import { type FailureAttempt, getFailureAttemptById } from '@/server/events/queries';
import { getEffectiveDomain } from '@/server/knowledge/domain';
import { assertKnowledgeIdsExist } from '@/server/knowledge/validate';
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
  | 'related_to_dumping_ground';

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

type EvidenceLevel = 'strong' | 'medium' | 'weak';

// §4.2 level computation from the in-window, judge-backed evidence set.
//   strong: 2+ in-window judge-backed failures (or 1 + explicit user note)
//   medium: exactly 1 in-window judge-backed failure
//   weak:   0 usable failures
function computeEvidenceLevel(usable: ResolvedEvidence[]): EvidenceLevel {
  const count = usable.length;
  if (count >= 2) return 'strong';
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
  // this edge (the "evidence touches both nodes" / order-evidence signal).
  const referencingEndpoint = usable.filter((ev) =>
    ev.attempt.referenced_knowledge_ids.some((kid) => endpoints.has(kid)),
  );
  const referencingBoth = usable.filter(
    (ev) =>
      ev.attempt.referenced_knowledge_ids.includes(change.from_knowledge_id) &&
      ev.attempt.referenced_knowledge_ids.includes(change.to_knowledge_id),
  );

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
      // derived_from is handled by the structural G6 generalization; any other
      // relation has no extra §4.3 predicate at Layer 1.
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
): Promise<RubricVerdict> {
  if (!isEdgePayload(payload)) {
    return { ok: true };
  }
  const change = payload.proposed_change;
  const fromId = change.from_knowledge_id;
  const toId = change.to_knowledge_id;

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

  // RB-4 — agents are rejected at medium/weak; only strong writes. Downweighting
  // medium is Layer 2 / YUK-174.
  if (level !== 'strong') {
    return {
      ok: false,
      gate: 'evidence_level',
      reason: `evidence level '${level}': agent edge requires strong evidence (≥2 in-window judge-backed failures, or 1 + explicit user note) within ${RUBRIC_EVIDENCE_WINDOW_DAYS}d`,
    };
  }

  // §4.2 + §4.3 — prerequisite / contrasts_with require 2 events UNLESS one has
  // explicit judge analysis. `strong` already means ≥2 usable (or 1 + user
  // note); enforce the relation-specific minimum explicitly for clarity.
  if (relationRequiresTwoEvents(change.relation_type)) {
    const hasExplicit = usable.some((ev) => ev.hasExplicitJudgeAnalysis);
    if (usable.length < 2 && !hasExplicit) {
      return {
        ok: false,
        gate: 'evidence_level',
        reason: `${change.relation_type} requires 2 in-window judge-backed failures unless one has explicit judge analysis`,
      };
    }
  }

  // ---- §4.3 relation-specific predicates (agents) ----
  const relationVerdict = relationGate(payload, usable);
  if (relationVerdict) {
    return { ok: false, gate: relationVerdict.gate, reason: relationVerdict.reason };
  }

  return { ok: true };
}
