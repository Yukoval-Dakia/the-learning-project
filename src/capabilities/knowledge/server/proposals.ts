// Knowledge proposals are events: propose → rate(accept|dismiss), chained by
// caused_by_event_id. Accept validates the locked base, writes the complete
// decision, and projects nodes in one transaction; no second structural writer.

import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { embedHash, knowledgeEmbedText } from '@/core/embed-source';
import { newId } from '@/core/ids';
import type { MergeRepairEntryT, SuggestionKindT } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import { type TopologyEdge, checkEdgeTopology } from '@/core/topology-gate';
import type { Db, Tx } from '@/db/client';
import {
  acquireLearningStateWriteLock,
  acquireSortedAdvisoryLocks,
} from '@/db/learning-state-lock';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { archiveProposalCooldownKey, writeArchiveProposal } from '@/kernel/proposals/producers';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { rewriteGoalScopeOnMerge } from '@/kernel/records/goal-commands';
import {
  rewriteLearningItemKnowledgeIds,
  rewriteQuestionKnowledgeIds,
} from '@/kernel/records/knowledge-merge-attribution';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';
import { rewireMisconceptionEdgesForKnowledgeMerge } from '@/kernel/records/misconception-edges';
import { retireLearnerAxisStateOnMerge } from '@/server/calibration/axis-writer';
import { retireKcTypedStateOnMerge } from '@/server/conjectures/typed-state';
import { retireFsrsStateOnMerge } from '@/server/fsrs/state';
import { retireMasteryStateOnMerge } from '@/server/mastery/state';
import { normalizeSubjectKey, sanitizeProposedNodeDomain } from '@/subjects/profile';
import {
  archiveKnowledgeEdgeFromEvents,
  createKnowledgeEdge,
  listAllLivePrerequisiteEdges,
  listLiveEdgesTouchingNode,
  reactivateKnowledgeEdge,
} from './edges';
import { requireKnowledgeHistory } from './node-history-guard';

type DbLike = Db | Tx;

function mutationSubjectId(payload: KnowledgeMutationPayload): string {
  switch (payload.mutation) {
    case 'propose_new':
      return payload.parent_id ?? newId();
    case 'reparent':
    case 'archive':
      return payload.node_id;
    case 'merge':
      return payload.into_id;
    case 'split':
      return payload.from_id;
  }
}

function mutationRowIds(payload: KnowledgeMutationPayload): string[] {
  switch (payload.mutation) {
    case 'propose_new':
      return [];
    case 'reparent':
    case 'archive':
      return [payload.node_id];
    case 'merge':
      return [payload.into_id, ...payload.from_ids];
    case 'split':
      return [payload.from_id];
  }
}

async function lockMutationRows(tx: Tx, payload: KnowledgeMutationPayload): Promise<void> {
  const ids = [...new Set(mutationRowIds(payload))].sort();
  if (ids.length === 0) return;

  // The accept event's timestamp is also the live row's materialization timestamp. Lock every row
  // that this mutation can update, in a stable order, before capturing that timestamp. Otherwise an
  // accept that waits behind a subject-root rename can commit second with an earlier timestamp,
  // making fold order disagree with the actual row-write order (YUK-728).
  await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(inArray(knowledge.id, ids))
    .orderBy(knowledge.id)
    .for('update');
}

// Mutation payloads emitted by UI / KnowledgeReviewTask. propose_new maps to
// ProposeKnowledge; the other mutations use the experimental namespace.

export type ProposeNewPayload = {
  mutation: 'propose_new';
  name: string;
  parent_id: string | null;
  /** Root creation (parent_id=null): domain the new root anchors (e.g.
   *  'english'). Omitted for child proposals — they inherit the parent's
   *  effective domain. */
  domain?: string;
};

export type ReparentPayload = {
  mutation: 'reparent';
  node_id: string;
  new_parent_id: string | null;
  expected_version: number;
};

export type MergePayload = {
  mutation: 'merge';
  from_ids: string[];
  into_id: string;
  expected_versions: Record<string, number>;
};

export type SplitPayload = {
  mutation: 'split';
  from_id: string;
  into: Array<{ name: string; parent_id: string | null }>;
  expected_version: number;
};

export type ArchivePayload = {
  mutation: 'archive';
  node_id: string;
  expected_version: number;
};

export type KnowledgeMutationPayload =
  | ProposeNewPayload
  | ReparentPayload
  | MergePayload
  | SplitPayload
  | ArchivePayload;

export interface WriteProposalEntry {
  payload: KnowledgeMutationPayload;
  reasoning: string;
  evidence_refs?: ProposalEvidenceRefT[];
  actor_ref?: string;
  caused_by_event_id?: string | null;
  task_run_id?: string;
  cost_usd?: number;
  // P5.6 / YUK-178 — optional proactive/corrective discriminator. Absence means
  // proactive (ND-SK-1); the propose tool sets it from the model-labeled arg.
  suggestion_kind?: SuggestionKindT;
}

/**
 * Shared pending-dedup cooldown key for propose_new: root proposals key on
 * domain, child proposals on parent id.
 */
export function knowledgeNodeCooldownKey(payload: {
  name: string;
  parent_id: string | null;
  domain?: string;
}): string {
  // URI-encode each component so ':' inside a domain or name cannot collide
  // across key positions. Canonicalizing the domain through the same sanitizer
  // the writer persists makes alias spellings dedupe to one pending proposal.
  const rootDomain =
    sanitizeProposedNodeDomain(payload.domain) ?? normalizeSubjectKey(payload.domain ?? '');
  return payload.parent_id === null
    ? `knowledge_node:root:${encodeURIComponent(rootDomain)}:${encodeURIComponent(payload.name)}`
    : `knowledge_node:${payload.parent_id}:${payload.name}`;
}

export interface KnowledgeMutationCooldown {
  /** Proposal kind the writer stores / the gate queries. */
  kind: 'knowledge_node' | 'archive' | 'knowledge_mutation';
  /**
   * Canonical key first (the one this writer persists). Archive also carries its
   * legacy equivalent; change-scoped mutations have no node-level alias.
   */
  cooldownKeys: readonly string[];
}

/**
 * The change a reparent/merge/split proposal asks for, independent of the CAS
 * token. Same identity means duplicate; a different target/parent/from-set is a
 * different proposal even on the same node.
 */
function mutationChangeIdentity(
  payload: ReparentPayload | MergePayload | SplitPayload,
): readonly unknown[] {
  switch (payload.mutation) {
    case 'reparent':
      return [payload.node_id, payload.new_parent_id];
    case 'merge':
      return [payload.into_id, [...payload.from_ids].sort()];
    case 'split':
      return [
        payload.from_id,
        payload.into
          .map(({ name, parent_id }) => [name, parent_id])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ];
  }
}

/**
 * Single source for a mutation's `(kind, cooldown_key)` dedup identity, shared by
 * the writer (stored marker) and the propose tool's pending/dismiss gate.
 */
export function knowledgeMutationCooldown(
  payload: KnowledgeMutationPayload,
): KnowledgeMutationCooldown {
  switch (payload.mutation) {
    case 'propose_new':
      return { kind: 'knowledge_node', cooldownKeys: [knowledgeNodeCooldownKey(payload)] };
    case 'archive':
      return {
        kind: 'archive',
        cooldownKeys: [
          archiveProposalCooldownKey('knowledge', payload.node_id),
          // Legacy experimental:knowledge_archive rows derive this key.
          `legacy_knowledge:archive:${payload.node_id}`,
        ],
      };
    case 'reparent':
    case 'merge':
    case 'split': {
      // Keep the key within the 300-char payload contract while still
      // distinguishing changes: subject id readable, identity digest carries the rest.
      const identityDigest = createHash('sha256')
        .update(JSON.stringify(mutationChangeIdentity(payload)))
        .digest('hex')
        .slice(0, 32);
      return {
        kind: 'knowledge_mutation',
        cooldownKeys: [
          `knowledge_mutation:${payload.mutation}:${mutationSubjectId(payload)}:${identityDigest}`,
        ],
      };
    }
  }
}

/** Writes one propose event and returns its id, which is also the proposal id. */
export async function writeKnowledgeProposeEvent(
  db: DbLike,
  entry: WriteProposalEntry,
): Promise<string> {
  const id = newId();
  const now = new Date();
  const reasoning = entry.reasoning;
  const actorRef = entry.actor_ref ?? 'dreaming';
  const causedByEventId = entry.caused_by_event_id ?? null;
  if (entry.payload.mutation === 'propose_new') {
    // Lane B ProposeKnowledge. parent_id=null proposes a domain ROOT anchored by
    // payload.domain at accept time. Fail fast: a domain-less root proposal could
    // never be accepted. Sanitizing here stores the canonical form the writer persists.
    let rootDomain: string | undefined;
    if (entry.payload.parent_id === null) {
      const sanitized = sanitizeProposedNodeDomain(entry.payload.domain);
      if (!sanitized) {
        throw new Error(
          "propose_new root creation requires a selectable domain — 'general'/blank is a fallback identity, not a node domain",
        );
      }
      rootDomain = sanitized;
    }
    await writeAiProposal(db, {
      id,
      actor_ref: actorRef,
      outcome: 'partial', // 'partial' = pending; 'success' = accepted (set by rate handler)
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: reasoning,
        evidence_refs: entry.evidence_refs ?? [],
        proposed_change: {
          mutation: 'propose_new',
          name: entry.payload.name,
          parent_id: entry.payload.parent_id,
          ...(rootDomain !== undefined ? { domain: rootDomain } : {}),
        },
        cooldown_key: knowledgeNodeCooldownKey(entry.payload),
        // P5.6 / YUK-178 — only set when present; absence means proactive.
        ...(entry.suggestion_kind ? { suggestion_kind: entry.suggestion_kind } : {}),
      },
      task_run_id: entry.task_run_id ?? null,
      caused_by_event_id: causedByEventId,
      cost_usd: entry.cost_usd,
      created_at: now,
    });
    return id;
  }

  if (entry.payload.mutation === 'archive') {
    const { mutation: _omit, ...rest } = entry.payload;
    void _omit;
    await writeArchiveProposal(db, {
      id,
      actor_ref: actorRef,
      target_subject_kind: 'knowledge',
      target_subject_id: entry.payload.node_id,
      proposed_change: {
        node_id: entry.payload.node_id,
        expected_version: entry.payload.expected_version,
      },
      reason_md: reasoning,
      evidence_refs: entry.evidence_refs,
      suggestion_kind: entry.suggestion_kind,
      legacy_event_override: {
        action: 'experimental:knowledge_archive',
        subject_kind: 'knowledge',
        subject_id: entry.payload.node_id,
        payload: {
          ...rest,
          reasoning,
        },
      },
      task_run_id: entry.task_run_id ?? null,
      caused_by_event_id: causedByEventId,
      cost_usd: entry.cost_usd,
      created_at: now,
    });
    return id;
  }

  // reparent / merge / split stay in the experimental:knowledge_<mutation>
  // namespace while carrying a typed ai_proposal payload for the inbox.
  const action = `experimental:knowledge_${entry.payload.mutation}` as const;
  const { mutation: _omit, ...rest } = entry.payload;
  const subjectId = mutationSubjectId(entry.payload);
  void _omit;
  await writeAiProposal(db, {
    id,
    actor_ref: actorRef,
    outcome: 'partial',
    payload: {
      kind: 'knowledge_mutation',
      target: { subject_kind: 'knowledge', subject_id: subjectId },
      reason_md: reasoning,
      evidence_refs: entry.evidence_refs ?? [],
      proposed_change: entry.payload,
      cooldown_key: knowledgeMutationCooldown(entry.payload).cooldownKeys[0],
      ...(entry.suggestion_kind ? { suggestion_kind: entry.suggestion_kind } : {}),
    },
    event_override: {
      action,
      subject_kind: 'knowledge',
      subject_id: subjectId,
      payload: {
        ...rest,
        reasoning,
        evidence_refs: entry.evidence_refs ?? [],
      },
    },
    caused_by_event_id: causedByEventId,
    task_run_id: entry.task_run_id ?? null,
    cost_usd: entry.cost_usd,
    created_at: now,
  });
  return id;
}

// Tree-mutation appliers operate on `knowledge` rows; called by the accept
// handler below and by tests/audit flows.

async function assertParentExists(db: DbLike, parentId: string): Promise<void> {
  const row = (
    await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.id, parentId), isNull(knowledge.archived_at)))
      .limit(1)
  )[0];
  if (!row) {
    throw new Error(`parent knowledge node not found or archived: ${parentId}`);
  }
}

// Shared preparation for explicit acceptance and automatic tagging. It does not
// write a node: each owner records its creation contract before projection.
export async function prepareProposedKnowledgeId(
  db: DbLike,
  payload: ProposeNewPayload,
): Promise<string> {
  // Root creation has no parent to assert; the projected row stamps payload.domain.
  // Re-check defensively: 'general'/blank can never persist as a node domain.
  if (payload.parent_id === null) {
    if (!sanitizeProposedNodeDomain(payload.domain)) {
      throw new Error(
        "propose_new root creation requires a selectable payload.domain — 'general'/blank is a fallback identity, not a node domain",
      );
    }
    return newId();
  }
  await assertParentExists(db, payload.parent_id);
  return newId();
}

type ReparentEmbeddingSnapshot = { id: string; name: string; hash: string | null };

// Single xact-scoped lock serializing reparent accepts. The subtree check below is
// only sound against a quiescent tree: two concurrent accepts on disjoint node pairs
// can each pass against the pre-write tree and commit a cycle together. Reparents are
// approval-gated and rare, so one global key costs nothing.
const REPARENT_TREE_LOCK_ID = 'reparent';

async function prepareReparent(
  tx: Tx,
  payload: ReparentPayload,
): Promise<ReparentEmbeddingSnapshot> {
  if (payload.new_parent_id === null) {
    throw new Error(
      'PR B: reparent to root (new_parent_id=null) not supported in Phase 1a single-domain',
    );
  }
  if (payload.new_parent_id === payload.node_id) {
    throw new Error(`reparent rejected: node ${payload.node_id} cannot become its own parent`);
  }
  await assertParentExists(tx, payload.new_parent_id);
  await rejectReparentCycle(tx, payload.node_id, payload.new_parent_id);

  // YUK-393 — snapshot name + hash before the move to detect a cross-domain shift.
  // A reparent can change the effective domain (resolved root-ward), which makes
  // the stored embedding stale; recompute after the parent_id commit.
  const beforeRows = await tx
    .select()
    .from(knowledge)
    .where(eq(knowledge.id, payload.node_id))
    .limit(1);
  const moved = beforeRows[0];

  if (!moved || moved.version !== payload.expected_version || moved.archived_at !== null) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or archived`);
  }
  await requireKnowledgeHistory(tx, moved);
  return { id: moved.id, name: moved.name, hash: moved.embed_content_hash };
}

/**
 * Reject a reparent whose new parent is inside the moved node's subtree (YUK-1601).
 * Hanging an ancestor under its own descendant — the 2-node mutual hang included —
 * closes a parent_id cycle. The walk is children-ward with a visited set, so an
 * already-corrupt tree cannot hang the check; archived rows stay traversable because
 * a stored cycle through them is still a cycle.
 */
async function rejectReparentCycle(tx: Tx, nodeId: string, newParentId: string): Promise<void> {
  // Serialize against a concurrent reparent accept BEFORE reading parent links, so
  // this check sees the tree as of the last serialized commit.
  await acquireSortedAdvisoryLocks(tx, 'knowledge_tree', [REPARENT_TREE_LOCK_ID]);
  const rows = await tx
    .select({ id: knowledge.id, parent_id: knowledge.parent_id })
    .from(knowledge);
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    const list = childrenByParent.get(row.parent_id);
    if (list) list.push(row.id);
    else childrenByParent.set(row.parent_id, [row.id]);
  }
  const visited = new Set<string>([nodeId]);
  const queue = [...(childrenByParent.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (visited.has(current)) continue; // pre-existing cycle in the subtree
    if (current === newParentId) {
      throw new Error(
        `reparent rejected: new parent ${newParentId} is a descendant of node ${nodeId} — ` +
          'hanging an ancestor under its own descendant closes a parent cycle',
      );
    }
    visited.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (!visited.has(child)) queue.push(child);
    }
  }
}

async function refreshReparentEmbedding(
  db: DbLike,
  moved: ReparentEmbeddingSnapshot,
): Promise<void> {
  // YUK-393 — re-embed-on-reparent (KC only). Recompute the hash from the new
  // effective domain and NULL the vector when it differs so embed_backfill
  // re-embeds. Do not cascade to descendants or the question subtree; a
  // same-domain move is a no-op, and a NULL vector just falls back to scalar reads.
  if (moved) {
    let newEffectiveDomain: string | null = null;
    try {
      newEffectiveDomain = await getEffectiveDomain(db, moved.id);
    } catch {
      // Broken tree (e.g. root with null domain): don't fail the reparent over an
      // embed-maintenance recompute; the backfill version net catches it.
      newEffectiveDomain = null;
    }
    const newHash = embedHash(
      knowledgeEmbedText({ name: moved.name, effectiveDomain: newEffectiveDomain }),
    );
    if (newHash !== moved.hash) {
      await db
        .update(knowledge)
        .set({ embedding: null, embed_content_hash: newHash })
        .where(eq(knowledge.id, moved.id));
    }
  }
}

async function archiveIncidentKnowledgeEdges(
  tx: Tx,
  nodeId: string,
  now: Date,
  reason: string,
): Promise<void> {
  // Endpoint knowledge row is already locked/updated by the caller. Preserve the global lock order
  // shared with live edge writers: endpoint knowledge row(s) → knowledge_edge advisory lock.
  await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', [nodeId]);
  const touching = await listLiveEdgesTouchingNode(tx, nodeId);
  for (const edge of touching) {
    await archiveKnowledgeEdgeFromEvents(tx, edge.id, { created_at: now, reasoning: reason });
  }
}

async function requireKnowledgeRetirementBase(tx: Tx, id: string, version: number): Promise<void> {
  const [node] = await tx.select().from(knowledge).where(eq(knowledge.id, id)).for('update');
  if (!node || node.version !== version || node.archived_at !== null) {
    throw new Error(`stale: knowledge ${id} version mismatch or already archived`);
  }
  await requireKnowledgeHistory(tx, node);
}

export async function prepareKnowledgeArchive(
  tx: Tx,
  payload: ArchivePayload,
  now: Date,
): Promise<void> {
  await requireKnowledgeRetirementBase(tx, payload.node_id, payload.expected_version);
  await archiveIncidentKnowledgeEdges(
    tx,
    payload.node_id,
    now,
    'archive: incident edge retired with knowledge node (YUK-546)',
  );
}

async function prepareKnowledgeSplit(tx: Tx, payload: SplitPayload, now: Date): Promise<string[]> {
  for (const entry of payload.into) {
    if (entry.parent_id === null) throw new Error('split into root (parent_id=null) not supported');
    await assertParentExists(tx, entry.parent_id);
  }
  await requireKnowledgeRetirementBase(tx, payload.from_id, payload.expected_version);
  await archiveIncidentKnowledgeEdges(
    tx,
    payload.from_id,
    now,
    'split: source incident edge retired without child rewire (YUK-546)',
  );
  return payload.into.map(() => newId());
}

// YUK-543 — merge attribution repair. Accepting a KC merge repairs 9 downstream
// attribution surfaces per absorbed from_id and pins a forensic MergeRepairEntry
// on the rate event. Details: docs/design/2026-07-02-kc-dedup-attribution-rewrite-spec.md §2.
//
// DELIBERATELY LEFT STALE: learning_session.scope_knowledge_ids — an in-flight
// placement probe just skips the absorbed KC for that session.
// NEVER REWRITTEN: learning_record.knowledge_ids, the append-only evidence layer,
// because a future unmerge must re-fit from un-aggregated observations.

// Canonical event-native rewire: archive-old + create-new through the edges.ts
// throat, paired with fold-visible events so replay reproduces it. Actor user/self
// matches the merge accept.

type EdgeRewired = MergeRepairEntryT['edges_rewired'][number];

/** Rewire a merge's incident edges with fold-visible archive/create events. */
export async function rewireKnowledgeEdges(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
  mergeFromIds: ReadonlySet<string>,
): Promise<EdgeRewired[]> {
  // Sorted advisory locks on both merge endpoints, mirroring the retire functions'
  // pattern. No async edge writer exists today, so this is future-proofing; a
  // background edge writer would make it REQUIRED against concurrent cycles.
  await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', [fromId, intoId]);

  const result: EdgeRewired[] = [];
  const touching = await listLiveEdgesTouchingNode(tx, fromId);
  if (touching.length === 0) return result;

  // Unbounded live-prerequisite mesh for the ADR-0034 topology gate: cycle detection
  // is only sound against the complete set, and the list reader truncates. Freshly
  // read and mutated in memory so edges that together form a cycle are caught.
  const livePrereq: TopologyEdge[] = await listAllLivePrerequisiteEdges(tx);
  const endpointIds = [
    ...new Set([
      intoId,
      ...touching.flatMap((edge) => [edge.from_knowledge_id, edge.to_knowledge_id]),
    ]),
  ];
  const endpointRows = await tx
    .select({ id: knowledge.id, parent_id: knowledge.parent_id })
    .from(knowledge)
    .where(inArray(knowledge.id, endpointIds));
  const treeParentLinks = endpointRows.flatMap((row) =>
    row.parent_id ? [{ child_id: row.id, parent_id: row.parent_id }] : [],
  );
  const dropFromMesh = (from: string, to: string) => {
    const i = livePrereq.findIndex(
      (e) =>
        e.relation_type === 'prerequisite' &&
        e.from_knowledge_id === from &&
        e.to_knowledge_id === to,
    );
    if (i >= 0) livePrereq.splice(i, 1);
  };
  // Map through the FULL merge so a loser→loser edge collapses to a self-loop.
  const mapEndpoint = (id: string) => (mergeFromIds.has(id) ? intoId : id);

  for (const edge of touching) {
    const oldFrom = edge.from_knowledge_id;
    const oldTo = edge.to_knowledge_id;
    const newFrom = mapEndpoint(oldFrom);
    const newTo = mapEndpoint(oldTo);

    // Self-loop after rewrite: archive-only; a self-edge is never meaningful.
    if (newFrom === newTo) {
      const archived = await archiveKnowledgeEdgeFromEvents(tx, edge.id, {
        created_at: now,
        reasoning: 'merge: KC attribution rewrite (YUK-543)',
      });
      if (!archived.archived) {
        throw new Error(`merge: knowledge_edge ${edge.id} changed before self-loop collapse`);
      }
      if (edge.relation_type === 'prerequisite') dropFromMesh(oldFrom, oldTo);
      result.push({ old_edge_id: edge.id, new_edge_id: null, outcome: 'collapsed_self_loop' });
      continue;
    }

    // ADR-0034 gate on the rewritten prerequisite edge. reject → abort the merge
    // tx (surfaced to the human); warn (transitive redundancy) → proceed.
    if (edge.relation_type === 'prerequisite') {
      const meshExcludingSelf = livePrereq.filter(
        (e) => !(e.from_knowledge_id === oldFrom && e.to_knowledge_id === oldTo),
      );
      const verdict = checkEdgeTopology(
        { from_knowledge_id: newFrom, to_knowledge_id: newTo, relation_type: 'prerequisite' },
        meshExcludingSelf,
        treeParentLinks,
      );
      if (verdict.status === 'reject') {
        throw new Error(
          `merge: knowledge_edge rewire ${edge.id} (${newFrom} --prerequisite--> ${newTo}) ` +
            `rejected by ADR-0034 topology gate=${verdict.gate}: ${verdict.reason} — aborting merge`,
        );
      }
    }

    const archived = await archiveKnowledgeEdgeFromEvents(tx, edge.id, {
      created_at: now,
      reasoning: 'merge: KC attribution rewrite (YUK-543)',
    });
    if (!archived.archived) {
      throw new Error(`merge: knowledge_edge ${edge.id} changed before rewire`);
    }
    if (edge.relation_type === 'prerequisite') dropFromMesh(oldFrom, oldTo);

    let newEdgeId: string | null = null;
    let outcome: EdgeRewired['outcome'];
    try {
      // SAVEPOINT: a 23505 from createKnowledgeEdge would abort the whole merge tx.
      // A nested tx rolls back only the failed create; the old edge's archive above
      // survives.
      newEdgeId = await tx.transaction(async (sp) => {
        const id = await createKnowledgeEdge(sp, {
          from_knowledge_id: newFrom,
          to_knowledge_id: newTo,
          relation_type: edge.relation_type,
          weight: edge.weight,
          reasoning: edge.reasoning,
          actor_kind: 'user',
          actor_ref: 'self',
          created_at: now,
        });
        return id;
      });
      outcome = 'rewired';
      if (edge.relation_type === 'prerequisite') {
        livePrereq.push({
          from_knowledge_id: newFrom,
          to_knowledge_id: newTo,
          relation_type: 'prerequisite',
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        // knowledge_edge_unique is GLOBAL, so a 23505 has two causes: a LIVE
        // duplicate (archive-as-duplicate is correct) or an archived TOMBSTONE
        // holding the slot (revive it, else a live relationship silently evaporates).
        const holder = (
          await tx
            .select({ id: knowledge_edge.id, archived_at: knowledge_edge.archived_at })
            .from(knowledge_edge)
            .where(
              and(
                eq(knowledge_edge.from_knowledge_id, newFrom),
                eq(knowledge_edge.to_knowledge_id, newTo),
                eq(knowledge_edge.relation_type, edge.relation_type),
              ),
            )
            .limit(1)
        )[0];
        if (holder && holder.archived_at !== null) {
          // Revive through the edges.ts throat and anchor a fold-legible
          // generate(create) event; the fold re-projects the row from that event.
          await reactivateKnowledgeEdge(tx, holder.id, {
            weight: edge.weight,
            reasoning: edge.reasoning,
            actor_kind: 'user',
            actor_ref: 'self',
            created_at: now,
          });
          newEdgeId = holder.id;
          outcome = 'reactivated';
          if (edge.relation_type === 'prerequisite') {
            livePrereq.push({
              from_knowledge_id: newFrom,
              to_knowledge_id: newTo,
              relation_type: 'prerequisite',
            });
          }
        } else {
          // LIVE duplicate: the existing edge represents the relationship; the
          // old edge's archive is the correct fold-legible outcome.
          newEdgeId = null;
          outcome = 'archived_duplicate';
        }
      } else if (err instanceof ApiError && err.code === 'not_found') {
        // The non-into endpoint is archived/missing — a degenerate edge; the archive alone drops it.
        console.warn('[rewireKnowledgeEdges] skipped create (endpoint archived/missing)', {
          edgeId: edge.id,
          newFrom,
          newTo,
        });
        newEdgeId = null;
        outcome = 'archived_dangling';
      } else {
        throw err;
      }
    }
    result.push({ old_edge_id: edge.id, new_edge_id: newEdgeId, outcome });
  }
  return result;
}

/**
 * YUK-543 — repairs all 9 downstream attribution surfaces for one absorbed
 * `fromId` → `intoId` and returns the MergeRepairEntry. Shared by merge accept and
 * the retroactive backfill so both repair the same way. Must run in a tx.
 */
export async function repairMergeAttributionForFromId(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
  mergeFromIds: ReadonlySet<string>,
): Promise<MergeRepairEntryT> {
  // YUK-497 — acquire the global learning-state write lock at ENTRY. Merge accept
  // already holds it (reentrant no-op); background sweeps used to take it after
  // rewireKnowledgeEdges' edge locks, creating a G↔knowledge_edge deadlock.
  await acquireLearningStateWriteLock(tx);
  return {
    from_id: fromId,
    question_ids_rewritten: await rewriteQuestionKnowledgeIds(tx, fromId, intoId),
    learning_item_ids_rewritten: await rewriteLearningItemKnowledgeIds(tx, fromId, intoId, now),
    goal_ids_rewritten: await rewriteGoalScopeOnMerge(tx, fromId, intoId, now),
    edges_rewired: await rewireKnowledgeEdges(tx, fromId, intoId, now, mergeFromIds),
    mastery_state: await retireMasteryStateOnMerge(tx, fromId, intoId),
    fsrs_state: await retireFsrsStateOnMerge(tx, fromId, intoId),
    axis_state: await retireLearnerAxisStateOnMerge(tx, fromId, intoId),
    kc_typed_state: await retireKcTypedStateOnMerge(tx, fromId, intoId),
    misconception_edges_rewritten: await rewireMisconceptionEdgesForKnowledgeMerge(
      tx,
      fromId,
      intoId,
      now,
    ),
  };
}

async function prepareKnowledgeMerge(
  tx: Tx,
  payload: MergePayload,
  now: Date,
): Promise<MergeRepairEntryT[]> {
  if (payload.from_ids.includes(payload.into_id)) {
    throw new Error(`merge: into_id (${payload.into_id}) cannot also appear in from_ids`);
  }
  if (new Set(payload.from_ids).size !== payload.from_ids.length) {
    throw new Error('merge: duplicate from_ids');
  }
  for (const fromId of payload.from_ids) {
    if (!(fromId in payload.expected_versions)) {
      throw new Error(`merge: expected_versions missing entry for ${fromId}`);
    }
  }
  // accept owns G -> sorted node locks. Validate all bases before repairing attribution.
  const [into] = await tx.select().from(knowledge).where(eq(knowledge.id, payload.into_id));
  if (!into || into.archived_at) {
    throw new Error(`stale: merge into_id ${payload.into_id} not found or archived`);
  }
  await requireKnowledgeHistory(tx, into);
  for (const fromId of payload.from_ids) {
    await requireKnowledgeRetirementBase(tx, fromId, payload.expected_versions[fromId]);
  }
  // Repairs use explicit identities, not archived node state. Keep nodes locked and live
  // until the complete immutable accept receipt is written; projection owns structural DML.
  const mergeFromIds = new Set(payload.from_ids);
  const repairLog: MergeRepairEntryT[] = [];
  for (const fromId of payload.from_ids) {
    repairLog.push(
      await repairMergeAttributionForFromId(tx, fromId, payload.into_id, now, mergeFromIds),
    );
  }
  return repairLog;
}

export type AcceptResult =
  | { kind: 'propose_new_applied'; new_node_id: string }
  | { kind: 'reparent_applied'; node_id: string; new_parent_id: string }
  | { kind: 'merge_applied'; into_id: string; archived_ids: string[] }
  | { kind: 'split_applied'; archived_id: string; new_node_ids: string[] }
  | { kind: 'archive_applied'; node_id: string };

export const ACCEPT_RESULT_KINDS: Record<AcceptResult['kind'], true> = {
  propose_new_applied: true,
  reparent_applied: true,
  merge_applied: true,
  split_applied: true,
  archive_applied: true,
};

interface ProposeEventRow {
  id: string;
  action: string;
  subject_id: string;
  payload: Record<string, unknown>;
}

async function readProposeEvent(db: DbLike, proposalId: string): Promise<ProposeEventRow> {
  const rows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      payload: event.payload,
      outcome: event.outcome,
    })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  if (row.subject_kind !== 'knowledge') {
    throw new Error(`proposal ${proposalId} is not a knowledge proposal`);
  }
  if (row.action !== 'propose' && !row.action.startsWith('experimental:knowledge_')) {
    throw new Error(
      `proposal ${proposalId} action '${row.action}' is not a knowledge mutation event`,
    );
  }
  return {
    id: row.id,
    action: row.action,
    subject_id: row.subject_id,
    payload: row.payload as Record<string, unknown>,
  };
}

async function assertNotAlreadyRated(db: DbLike, proposalId: string): Promise<void> {
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, proposalId),
      ),
    )
    .limit(1);
  if (rows.length > 0) {
    const r = rows[0].payload as { rating?: string };
    throw new Error(`proposal ${proposalId} is not pending (rating=${r.rating ?? 'unknown'})`);
  }
}

// YUK-471 — knowledge ids touched by an accept, re-projected and compared against
// the row the imperative path wrote in the same tx.
function affectedNodeIds(result: AcceptResult): string[] {
  switch (result.kind) {
    case 'propose_new_applied':
      return [result.new_node_id];
    case 'reparent_applied':
      return [result.node_id];
    case 'archive_applied':
      return [result.node_id];
    case 'merge_applied':
      return [result.into_id, ...result.archived_ids];
    case 'split_applied':
      return [result.archived_id, ...result.new_node_ids];
    default: {
      // Exhaustiveness guard: noImplicitReturns is off, so `never` forces a compile
      // error when a new AcceptResult kind is added.
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/** Apply a pending knowledge proposal in one locked transaction. */
export async function acceptProposal(db: Db, proposalId: string): Promise<AcceptResult> {
  // Concurrent double-accept must not duplicate apply side effects. The status
  // check and mutation apply share a tx with SELECT … FOR UPDATE on the propose
  // event row; the second caller sees the first rate event and throws not-pending.
  let staleError: Error | null = null;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM event WHERE id = ${proposalId} FOR UPDATE`);

      const propose = await readProposeEvent(tx, proposalId);
      await assertNotAlreadyRated(tx, proposalId);

      const mutationKind: string =
        propose.action === 'propose'
          ? 'propose_new'
          : propose.action.replace(/^experimental:knowledge_/, '');
      const { reasoning: _r, ...payloadBody } = propose.payload as { reasoning?: string };
      void _r;

      const apply: KnowledgeMutationPayload = {
        mutation: mutationKind,
        ...(payloadBody as Record<string, unknown>),
      } as KnowledgeMutationPayload;

      // YUK-471 / YUK-728 — one materialization timestamp. Lock existing rows first
      // so timestamp order matches serialized write order; thread the instant through
      // apply and rate=accept for byte-exact fold == row parity.
      if (apply.mutation === 'merge') await acquireLearningStateWriteLock(tx);
      await lockMutationRows(tx, apply);
      const now = new Date();

      let result: AcceptResult;
      let reparentEmbedding: ReparentEmbeddingSnapshot | null = null;
      // YUK-543 — merge-repair breadcrumb pinned on the rate event and used by
      // the post-rate learning_item parity assert.
      let mergeRepair: MergeRepairEntryT[] | null = null;
      try {
        switch (apply.mutation) {
          case 'propose_new': {
            const newNodeId = await prepareProposedKnowledgeId(tx, apply);
            result = { kind: 'propose_new_applied', new_node_id: newNodeId };
            break;
          }
          case 'reparent': {
            if (propose.subject_id !== apply.node_id) {
              throw new Error(`reparent proposal ${proposalId} does not identify its target node`);
            }
            reparentEmbedding = await prepareReparent(tx, apply);
            if (apply.new_parent_id === null) {
              throw new Error('reparent payload must have new_parent_id');
            }
            result = {
              kind: 'reparent_applied',
              node_id: apply.node_id,
              new_parent_id: apply.new_parent_id,
            };
            break;
          }
          case 'archive': {
            if (propose.subject_id !== apply.node_id)
              throw new Error(`archive proposal ${proposalId} does not identify its target node`);
            await prepareKnowledgeArchive(tx, apply, now);
            result = { kind: 'archive_applied', node_id: apply.node_id };
            break;
          }
          case 'merge': {
            if (propose.subject_id !== apply.into_id)
              throw new Error(
                `merge proposal ${proposalId} does not identify its destination node`,
              );
            mergeRepair = await prepareKnowledgeMerge(tx, apply, now);
            result = {
              kind: 'merge_applied',
              into_id: apply.into_id,
              archived_ids: apply.from_ids,
            };
            break;
          }
          case 'split': {
            if (propose.subject_id !== apply.from_id)
              throw new Error(`split proposal ${proposalId} does not identify its source node`);
            const newIds = await prepareKnowledgeSplit(tx, apply, now);
            result = {
              kind: 'split_applied',
              archived_id: apply.from_id,
              new_node_ids: newIds,
            };
            break;
          }
          default: {
            const _exhaustive: never = apply;
            void _exhaustive;
            const kind = (apply as { mutation?: unknown }).mutation;
            throw new Error(
              `unknown_mutation: proposal ${proposalId} payload mutation=${JSON.stringify(kind)}`,
            );
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (/^stale/i.test(msg)) {
          // Capture so the rollback marker can be written outside the tx that is
          // about to roll back.
          staleError = e as Error;
        }
        throw e;
      }

      // YUK-471 — thread minted node ids onto the rate=accept event and the reverse
      // index (nodeId → anchor propose event) for replay. Only propose_new/split mint
      // ids; reparent/merge/archive omit materialized_ids.
      let mintedKnowledgeIds: string[];
      switch (result.kind) {
        case 'propose_new_applied':
          mintedKnowledgeIds = [result.new_node_id];
          break;
        case 'split_applied':
          mintedKnowledgeIds = result.new_node_ids;
          break;
        default:
          mintedKnowledgeIds = [];
      }
      const materializedIds =
        mintedKnowledgeIds.length > 0 ? { knowledge: mintedKnowledgeIds } : undefined;

      // First-write-wins reverse-index write; anchor = the propose event id.
      for (const mintedId of mintedKnowledgeIds) {
        await upsertMaterializedIdIndex(tx, {
          materialized_id: mintedId,
          anchor_event_id: proposalId,
          subject_kind: 'knowledge',
        });
      }

      // Accept event uses the shared `now` so fold(events) reproduces the row's
      // created_at/updated_at exactly.
      await writeEvent(tx, {
        id: newId(),
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: {
          rating: 'accept',
          ...(materializedIds ? { materialized_ids: materializedIds } : {}),
          // YUK-543 — pin the merge-repair breadcrumb (only merge accepts set it).
          ...(mergeRepair ? { merge_repair: mergeRepair } : {}),
        },
        caused_by_event_id: proposalId,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });

      // The complete decision and minted identities are visible before the only structural write.
      for (const id of affectedNodeIds(result)) {
        await projectKnowledgeNodeGuarded(tx, id);
      }

      if (reparentEmbedding) await refreshReparentEmbedding(tx, reparentEmbedding);
      return result;
    });
  } catch (e) {
    if (staleError) {
      // Best-effort rollback marker so later reads see status='stale', not pending.
      try {
        await writeEvent(db, {
          id: newId(),
          session_id: null,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'rate',
          subject_kind: 'event',
          subject_id: proposalId,
          outcome: 'success',
          payload: { rating: 'rollback' },
          caused_by_event_id: proposalId,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: new Date(),
        });
      } catch (err) {
        console.warn('acceptProposal: failed to write stale rate event', err);
      }
    }
    throw e;
  }
}

/** Write rate=dismiss; idempotent when the proposal is already rated. */
export async function dismissProposal(db: Db, proposalId: string): Promise<void> {
  // Idempotent on already-rated: skip if a rate event exists.
  const existing = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, proposalId),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  // Guard against dismissing an arbitrary event id; only proposals may be rated.
  const proposeRows = await db
    .select({ id: event.id, action: event.action, subject_kind: event.subject_kind })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  if (proposeRows.length === 0) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  const proposeRow = proposeRows[0];
  const isProposal =
    proposeRow.action === 'propose' || proposeRow.action.startsWith('experimental:knowledge_');
  if (!isProposal) {
    throw new Error(`event ${proposalId} is not a proposal (action='${proposeRow.action}')`);
  }

  await writeEvent(db, {
    id: newId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: { rating: 'dismiss' },
    caused_by_event_id: proposalId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}
