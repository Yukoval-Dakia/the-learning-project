// P5.4 / YUK-143 — deterministic proposal-quality rubric (Layer 1).
//
// Single shared validator (RB-1) for agent edge proposals, called before
// writeAiProposal so no caller bypasses the floor. Gates and evidence levels are
// documented in docs/modules/knowledge.md §4.2–§4.3. The adaptive accept-learned
// bias is Layer 2 / YUK-174, intentionally elsewhere. Verdict shape is stable:
// { ok:true } | { ok:false; gate; reason }.

import { eq } from 'drizzle-orm';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
// P5.4-L2 / YUK-174 — type-only adaptive gate input. The bump is computed at the
// call site and carried in, keeping this validator pure.
import type { AdaptiveGateInput } from '@/kernel/proposals/adaptive-bias';
import {
  type EffectiveFailureCause,
  effectiveCauseForFailureAttempt,
} from '@/kernel/read-models/cause-policy';
import { type FailureAttempt, getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { assertKnowledgeIdsExist } from '@/kernel/read-models/knowledge-validate';

// RB-5 — single-source evidence window (§4.2 "recent": 30 days).
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
  // derived_from (and the experimental default) still requires ≥1 in-window
  // judge-backed failure referencing an endpoint, like the other §4.3 relations.
  | 'derived_from_no_endpoint_evidence';

export type RubricVerdict = { ok: true } | { ok: false; gate: RubricGate; reason: string };

export interface RubricValidatorCtx {
  isAgent: boolean;
  actorRef: string;
}

// §4.4 — G7a reasoning-depth heuristic (no LLM): reject generic phrasing that
// names no concrete signal (event id, node id, or quoted knowledge name).
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

// Deliberately loose: reject empty filler, not genuine prose.
function namesConcreteSignal(reason: string): boolean {
  if (/[a-z]+_[a-z0-9_]+/i.test(reason)) return true;
  if (/(attempt|judge|cause|event|失败|错题|attempt_event|judge cause)/i.test(reason)) return true;
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
  if (concrete) return false;
  if (hitsDenylist) return true;
  return trimmed.length < 12;
}

// P5.4-L2 — format the carried adaptive fields for the reject reason; never re-reads.
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
    // "judge-backed" reuses the existing cause resolver: an active agent judge
    // or an active user_cause counts as authoritative backing. A user cause
    // without prose still counts; the stricter check is `hasExplicitJudgeAnalysis`.
    const judgeBacked = cause !== null;
    const hasExplicitJudgeAnalysis =
      attempt.judge !== undefined &&
      typeof attempt.judge.cause.analysis_md === 'string' &&
      attempt.judge.cause.analysis_md.trim().length > 0;
    out.push({ attempt, cause, inWindow, judgeBacked, hasExplicitJudgeAnalysis });
  }
  return out;
}

// Effective refs = attempt refs ∪ judge refs. The judge may point at an endpoint
// the attempt left empty or stale; merging is additive and never loosens the
// leveling. Used by same-pattern overlap and the endpoint/confusion checks.
function effectiveReferencedKnowledgeIds(ev: ResolvedEvidence): string[] {
  const attemptRefs = ev.attempt.referenced_knowledge_ids;
  const judgeRefs = ev.attempt.judge?.referenced_knowledge_ids ?? [];
  if (judgeRefs.length === 0) return attemptRefs;
  return [...new Set([...attemptRefs, ...judgeRefs])];
}

type EvidenceLevel = 'strong' | 'medium' | 'weak';

// §4.2 strong = 2+ recent failures showing the SAME PATTERN: shared effective
// cause category OR overlapping referenced knowledge. Two unrelated failures stay
// medium (agents are rejected at medium, RB-4).
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
      // Effective refs make a shared judge-referenced node count as same-pattern.
      const aRefs = new Set(effectiveReferencedKnowledgeIds(a));
      const sharesKnowledge = effectiveReferencedKnowledgeIds(b).some((kid) => aRefs.has(kid));
      if (sharesKnowledge) return true;
    }
  }
  return false;
}

// §4.2 level: strong = 2+ same-pattern failures or 1 + explicit user note;
// medium = 1 failure or unrelated 2+ (agents rejected); weak = none.
function computeEvidenceLevel(usable: ResolvedEvidence[]): EvidenceLevel {
  const count = usable.length;
  if (count >= 2) {
    return hasSamePatternPair(usable) ? 'strong' : 'medium';
  }
  if (count === 1) {
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

// §4.2/§4.3 — prerequisite / contrasts_with need 2 events unless one carries
// explicit analysis: agent analysis_md or non-empty user notes. A plain tagged
// failure does not qualify.
function hasExplicitSingleEventBasis(usable: ResolvedEvidence[]): boolean {
  return usable.some(
    (ev) =>
      ev.hasExplicitJudgeAnalysis || (ev.attempt.user_cause?.user_notes ?? '').trim().length > 0,
  );
}

// §4.3 relation-specific predicates (agents only); strict-but-cheap, no LLM.
function relationGate(
  payload: EdgePayload,
  usable: ResolvedEvidence[],
): { gate: RubricGate; reason: string } | null {
  const change = payload.proposed_change;
  const relation = change.relation_type;
  const endpoints = new Set([change.from_knowledge_id, change.to_knowledge_id]);

  // In-window judge-backed failures referencing an endpoint. Effective refs count,
  // so a judge-referenced endpoint satisfies the check even when attempt refs are empty.
  const referencingEndpoint = usable.filter((ev) =>
    effectiveReferencedKnowledgeIds(ev).some((kid) => endpoints.has(kid)),
  );
  const referencingBoth = usable.filter((ev) => {
    const refs = new Set(effectiveReferencedKnowledgeIds(ev));
    return refs.has(change.from_knowledge_id) && refs.has(change.to_knowledge_id);
  });

  switch (relation) {
    case 'prerequisite': {
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
      // Require confusion evidence: one failure referencing BOTH endpoints.
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
      // Cheap role proxy: direction plus endpoint-referencing evidence. Layer 1
      // cannot read node roles deterministically.
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
      // Weak edge only; require endpoint evidence to avoid a dumping ground.
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
      // derived_from (and experimental relations) keep the structural G6 check but
      // must also reference an endpoint; shared-cause failures touching neither
      // node are not enough.
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

// G6 — reject an edge that merely restates tree ancestry (§4.3 derived_from and
// the related_to parent-only case). Walks up to MAX_DEPTH from each endpoint.
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
 * P5.4 Layer-1 rubric (RB-1). Agents run structural G1–G6, G7a reasoning depth,
 * the §4.2 evidence floor, and §4.3 relation predicates. User-edited proposals
 * run structural gates only (RB-3). Non-edge kinds return { ok:true }.
 */
export async function validateProposalQuality(
  payload: AiProposalPayloadT,
  db: DbLike,
  ctx: RubricValidatorCtx,
  // P5.4-L2 / YUK-174 — optional adaptive input. Omitted is byte-identical to L1.
  // `tightenMediumToStrong` only suppresses the explicit-single-event rescue; it
  // never loosens an L1 reject and adds no new gate.
  adaptive?: AdaptiveGateInput,
): Promise<RubricVerdict> {
  if (!isEdgePayload(payload)) {
    return { ok: true };
  }
  const change = payload.proposed_change;
  const fromId = change.from_knowledge_id;
  const toId = change.to_knowledge_id;

  // ADR-0032 D4-E1 — archive is the inverse of create: it carries no evidence by
  // design, so skip the create-only gates. Same-subject endpoints are re-asserted
  // at the accept applier; the self-edge guard stays for shape stability.
  if (change.edge_op === 'archive') {
    if (fromId === toId) {
      return { ok: false, gate: 'self_edge', reason: 'from_knowledge_id equals to_knowledge_id' };
    }
    return { ok: true };
  }

  // ---- §4.1 structural class (G1–G6) — runs for agents AND users (RB-3) ----

  if (fromId === toId) {
    return { ok: false, gate: 'self_edge', reason: 'from_knowledge_id equals to_knowledge_id' };
  }

  // G2 — both nodes exist + are active.
  const exist = await assertKnowledgeIdsExist(db, [fromId, toId]);
  if (!exist.ok) {
    return {
      ok: false,
      gate: 'unknown_node',
      reason: `knowledge node missing or archived: ${exist.missing.join(',')}`,
    };
  }

  // G3 — same subject. getEffectiveDomain is typed for Db but is read-only and
  // runtime-compatible with the gate transaction's Tx.
  const [fromDomain, toDomain] = await Promise.all([
    getEffectiveDomain(db, fromId),
    getEffectiveDomain(db, toId),
  ]);
  if (fromDomain !== toDomain) {
    return {
      ok: false,
      gate: 'cross_subject',
      reason: 'knowledge nodes resolve to different subjects',
    };
  }

  // G6 applies only to relations whose semantics ARE hierarchy: related_to and
  // derived_from. prerequisite / applied_in / contrasts_with may legitimately
  // align with ancestry; their §4.3 gates carry the semantic check.
  const g6Applies =
    change.relation_type === 'related_to' || change.relation_type === 'derived_from';
  if (g6Applies && (await restatesTreeAncestry(db, fromId, toId))) {
    return {
      ok: false,
      gate: 'parent_semantic_duplicate',
      reason: 'edge only restates an existing tree parent/child relationship',
    };
  }

  // G4/G5 are short-circuit dedup no-ops at each call site; their gate strings
  // remain in RubricGate for verdict-shape stability.

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

  // §4.3 single-event relaxation for prerequisite / contrasts_with: a single
  // in-window failure WITH explicit analysis is the documented exception to the
  // 2-event floor. Relation-scoped and explicit-analysis gated; `usable.length===1`
  // keeps two unrelated events from taking the rescue. Endpoint touching is still
  // enforced by relationGate below.
  const explicitSingleEventRescueBasis =
    requiresTwoEvents &&
    usable.length === 1 &&
    level === 'medium' &&
    hasExplicitSingleEventBasis(usable);

  // P5.4-L2 — tighten-only: suppress the rescue when this (kind, relation) has a
  // low acceptance rate with enough samples. It can only turn a would-pass into a
  // reject; strong evidence never reaches this branch.
  const adaptiveTighten = adaptive?.tightenMediumToStrong === true;
  const explicitSingleEventRescue = explicitSingleEventRescueBasis && !adaptiveTighten;

  // RB-4 — agents need strong evidence, or the §4.3 rescue unless L2 suppressed it.
  if (level !== 'strong' && !explicitSingleEventRescue) {
    // Annotate only when the bump removed an otherwise-available rescue. The gate
    // stays 'evidence_level' (no new RubricGate).
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

  // A strong level reached without the rescue must still satisfy the
  // ≥2-or-explicit minimum (e.g. a future single-event strong path).
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
