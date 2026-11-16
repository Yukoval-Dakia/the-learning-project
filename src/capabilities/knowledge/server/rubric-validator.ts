// Structural rubric for knowledge edge proposals (RB-1, correctness class
// only): self-edge, unknown node, cross-subject, and parent-restating
// duplicates. Evidence rides in `evidence_refs` — sufficiency is the learner's
// accept call, not a write-time gate. Verdict shape is stable:
// { ok:true } | { ok:false; gate; reason }.

import { eq } from 'drizzle-orm';
import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { assertKnowledgeIdsExist } from '@/kernel/read-models/knowledge-validate';

type DbLike = Db | Tx;

// The stable `gate` string set (spec §3.4). G4/G5 are short-circuit dedup no-ops
// at each call site; their gate strings remain for verdict-shape stability.
export type RubricGate =
  | 'self_edge'
  | 'unknown_node'
  | 'cross_subject'
  | 'parent_semantic_duplicate'
  | 'duplicate_live_edge'
  | 'duplicate_pending';

export type RubricVerdict = { ok: true } | { ok: false; gate: RubricGate; reason: string };

/** The standard each gate enforces, worded so a caller can tell what to change. */
export const RUBRIC_GATE_CRITERIA: Record<RubricGate, string> = {
  self_edge: 'an edge must join two different knowledge points',
  unknown_node: 'both endpoints must be existing, unarchived knowledge points',
  cross_subject: 'both endpoints must belong to the same subject',
  parent_semantic_duplicate:
    'related_to / derived_from must add something beyond the tree parent/child link; use prerequisite for a prerequisite',
  duplicate_live_edge: 'the same edge must not already be live',
  duplicate_pending: 'the same edge must not already be pending review',
};

type EdgePayload = Extract<AiProposalPayloadT, { kind: 'knowledge_edge' }>;

function isEdgePayload(payload: AiProposalPayloadT): payload is EdgePayload {
  return payload.kind === 'knowledge_edge';
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
 * Structural gates (G1–G6) for edge proposals, identical for agents and users.
 * Non-edge kinds return { ok:true }.
 */
export async function validateProposalQuality(
  payload: AiProposalPayloadT,
  db: DbLike,
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

  // ---- §4.1 structural class (G1–G6) ----

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
  // align with ancestry.
  const g6Applies =
    change.relation_type === 'related_to' || change.relation_type === 'derived_from';
  if (g6Applies && (await restatesTreeAncestry(db, fromId, toId))) {
    return {
      ok: false,
      gate: 'parent_semantic_duplicate',
      reason: 'edge only restates an existing tree parent/child relationship',
    };
  }

  return { ok: true };
}
