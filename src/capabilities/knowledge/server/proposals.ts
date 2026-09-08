// Phase 1c.1 Step 9.D — event-based knowledge proposal handlers.
//
// Pre-Step-9: writeDreamingProposal INSERTed dreaming_proposal rows; accept/
// dismiss UPDATEd dreaming_proposal.status. Post-Step-9 the legacy table is
// gone; proposals are events:
//   - propose_new   → Lane B ProposeKnowledge event (action='propose',
//                     subject_kind='knowledge', payload={name, parent_id, reasoning})
//   - reparent / merge / split / archive → experimental:knowledge_<mutation>
//     events (ExperimentalEvent escape hatch; payload carries mutation body)
//
// accept/dismiss flow writes a RateEvent (action='rate', subject_kind='event')
// chained via caused_by_event_id = propose event id. Acceptance validates locked
// history, prepares side effects, writes the complete decision, then projects nodes
// in one transaction. There is no second structural writer.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rewriteGoalScopeOnMerge } from '@/capabilities/agency/public';
import {
  rewriteLearningItemKnowledgeIds,
  rewriteQuestionKnowledgeIds,
} from '@/capabilities/practice/public';
import { newId } from '@/core/ids';
import type { MergeRepairEntryT, SuggestionKindT } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { writeArchiveProposal } from '@/kernel/proposals/producers';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { acquireLearningStateWriteLock, acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { embedHash, knowledgeEmbedText } from '@/server/ai/embed-source';
import { retireLearnerAxisStateOnMerge } from '@/server/calibration/axis-writer';
import { retireKcTypedStateOnMerge } from '@/server/conjectures/typed-state';
import { retireFsrsStateOnMerge } from '@/server/fsrs/state';
import { retireMasteryStateOnMerge } from '@/server/mastery/state';
import { gatherAndFoldKnowledgeNode } from '@/server/projections/gather';
import { projectKnowledgeNodeGuarded } from '@/server/projections/knowledge';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import { knowledgeLiveRowToSnapshot } from '@/server/projections/parity';
import { diffSnapshots } from '@/server/projections/snapshot-diff';
import {
  archiveKnowledgeEdgeFromEvents,
  createKnowledgeEdge,
  listAllLivePrerequisiteEdges,
  listLiveEdgesTouchingNode,
  reactivateKnowledgeEdge,
} from './edges';
import { rewireMisconceptionEdgesForKnowledgeMerge } from './misconception-edges';
import { type TopologyEdge, checkEdgeTopology } from './topology-gate';

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

// =============================================================================
// Mutation payload types (unchanged from pre-Step-9 — UI / KnowledgeReviewTask
// still emit these shapes; we map propose_new → ProposeKnowledge and the rest
// to the experimental namespace).
// =============================================================================

export type ProposeNewPayload = {
  mutation: 'propose_new';
  name: string;
  parent_id: string | null;
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
  // P5.6 / YUK-178 — OPTIONAL proactive/corrective discriminator threaded onto the
  // ai_proposal payload this writer builds (knowledge_node / knowledge_mutation /
  // archive). Absence === proactive (ND-SK-1). Set explicitly by the
  // propose_knowledge_mutation tool from the model-labeled arg (§4.1/§4.2).
  suggestion_kind?: SuggestionKindT;
}

// =============================================================================
// writeKnowledgeProposeEvent — single-point propose-event writer (replaces the
// legacy writeDreamingProposal). Returns the new event id (which doubles as
// the proposal id post-Step-9).
// =============================================================================

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
    // Lane B ProposeKnowledge — payload locked to { name, parent_id, reasoning }.
    // parent_id is required (Lane B forbids null); PR A scope already enforced
    // parent_id non-null at the apply step; here we surface as a TypeError.
    if (entry.payload.parent_id === null) {
      throw new Error(
        'writeKnowledgeProposeEvent: propose_new with parent_id=null not supported (PR A scope)',
      );
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
        },
        cooldown_key: `knowledge_node:${entry.payload.parent_id}:${entry.payload.name}`,
        // P5.6 / YUK-178 — model-labeled discriminator (default proactive at the
        // tool call site); only set when present so the field stays absent for
        // non-tool callers (KnowledgeReviewTask etc.), keeping absence === proactive.
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
      // P5.6 / YUK-178 — pass through the model-labeled discriminator.
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

  // Other mutations (reparent / merge / split) stay in the legacy
  // experimental:knowledge_<mutation> event namespace for the knowledge owner,
  // while carrying a typed ai_proposal payload for unified inbox semantics.
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
      cooldown_key: `knowledge_mutation:${entry.payload.mutation}:${subjectId}`,
      // P5.6 / YUK-178 — model-labeled discriminator; absent → proactive.
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

// =============================================================================
// Tree-mutation appliers — unchanged from pre-Step-9 (operate on `knowledge`
// rows). Called by accept handler below + by external callers (tests, audit
// flows).
// =============================================================================

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

// Shared preparation for explicit proposal acceptance and automatic tagging.
// This does not write a node: each owner records its existing creation contract
// before projection. No caller-selectable imperative mode remains for new nodes.
export async function prepareProposedKnowledgeId(
  db: DbLike,
  payload: ProposeNewPayload,
): Promise<string> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  return newId();
}

type ReparentEmbeddingSnapshot = { id: string; name: string; hash: string | null };

async function prepareReparent(
  db: DbLike,
  payload: ReparentPayload,
): Promise<ReparentEmbeddingSnapshot> {
  if (payload.new_parent_id === null) {
    throw new Error(
      'PR B: reparent to root (new_parent_id=null) not supported in Phase 1a single-domain',
    );
  }
  await assertParentExists(db, payload.new_parent_id);

  // YUK-393 — snapshot name + stored embed hash BEFORE the move so we can detect a
  // cross-domain shift afterwards. A reparent can change the KC's EFFECTIVE domain
  // (effective-domain is resolved root-ward; moving under a different-subject root
  // changes it), and knowledgeEmbedText now folds effective-domain — so a
  // cross-domain move makes the stored vector stale. (Read here, recomputed after
  // the parent_id commit so the walk sees the new position.)
  const beforeRows = await db
    .select()
    .from(knowledge)
    .where(eq(knowledge.id, payload.node_id))
    .limit(1);
  const moved = beforeRows[0];

  if (!moved || moved.version !== payload.expected_version || moved.archived_at !== null) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or archived`);
  }
  await requireKnowledgeHistory(db, moved);
  return { id: moved.id, name: moved.name, hash: moved.embed_content_hash };
}

async function refreshReparentEmbedding(
  db: DbLike,
  moved: ReparentEmbeddingSnapshot,
): Promise<void> {
  // YUK-393 — re-embed-on-reparent (KC-ONLY). Resolve the NEW effective domain
  // (the walk now reflects the committed parent_id), recompute the embed hash, and
  // if it differs from the stored one, NULL this KC's embedding so the nightly
  // embed_backfill re-embeds with the new effective-domain context. RED LINE: this
  // touches ONLY the moved node — it does NOT cascade to descendant KCs or to the
  // question subtree (a same-domain move is a no-op; a child's effective domain is
  // unchanged when the moved node keeps the same root subject). NULLing embedding
  // degrades gracefully (excluded from cosine → scalar path), zero read regression.
  if (moved) {
    let newEffectiveDomain: string | null = null;
    try {
      newEffectiveDomain = await getEffectiveDomain(db, moved.id);
    } catch {
      // Broken tree (root with null domain etc.) — don't fail the reparent over an
      // embed-maintenance recompute; leave the (now possibly stale) vector for the
      // backfill version net to catch. NULL effective domain ≡ legacy bare text.
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

async function requireKnowledgeHistory(
  db: DbLike,
  node: typeof knowledge.$inferSelect,
): Promise<void> {
  const folded = await gatherAndFoldKnowledgeNode(db, node.id);
  if (!folded) throw new Error(`knowledge ${node.id} requires complete history before mutation`);
  if (diffSnapshots(knowledgeLiveRowToSnapshot(node), folded).length > 0) {
    throw new Error(`knowledge ${node.id} has fold/live drift; repair history before mutation`);
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

// =============================================================================
// YUK-543 — merge attribution repair. When a KC merge is accepted, preparation
// repairs 9 downstream attribution surfaces per absorbed from_id (in addition to the
// original knowledge-row archive + merged_from append), returning a forensic
// MergeRepairEntry[] the accept path pins on its rate event. See the diff-level plan
// in docs/design/2026-07-02-kc-dedup-attribution-rewrite-spec.md §2.
//
// DELIBERATELY LEFT STALE (documented, not silent): learning_session.scope_knowledge_ids
// (schema.ts:757-762) — an in-flight placement probe holding an absorbed KC just skips it
// for that session's remaining duration (session-ephemeral, spec §2 table).
//
// DELIBERATELY NEVER REWRITTEN: learning_record.knowledge_ids — the append-only ATOMIC evidence
// layer. It is the feasibility precondition for a future unmergeKnowledge() (re-fit new per-KC
// parameters from un-aggregated observations, Sentry-fingerprint style) and MUST stay outside
// every rewrite pass, including this one (YUK-543 review L2; see the schema.ts contract comment).
// =============================================================================

// ── knowledge_edge (LIVE fold, PROJECTION_IS_WRITER=1) — event-native rewire ─────────────────────
// Mirrors applyEdgeSupersede (propose_edge.ts): archive-old + create-new via the imperative
// edges.ts functions PAIRED with fold-visible `generate` events, so the LIVE edge fold reproduces
// every merge-driven endpoint change (a raw UPDATE would be invisible to the fold → resurrected on
// rebuild). Actor user/self matches the merge accept.

type EdgeRewired = MergeRepairEntryT['edges_rewired'][number];

export async function rewireKnowledgeEdges(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
  mergeFromIds: ReadonlySet<string>,
): Promise<EdgeRewired[]> {
  // YUK-543 review L1 — sorted advisory locks on both merge endpoints ('knowledge_edge:<id>'
  // namespace, mirroring the four retire fns' pattern). No async edge writer exists today (edge
  // writes are propose/accept human-gated; the grading worker never writes edges), so this is
  // doctrine consistency + future-proofing, not a live race fix. The symmetric propose-side lock is
  // a Linear follow-up; if any background edge writer is ever introduced, that follow-up upgrades
  // to REQUIRED (two READ COMMITTED txs each passing the topology gate then merging = silent cycle).
  await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', [fromId, intoId]);

  const result: EdgeRewired[] = [];
  const touching = await listLiveEdgesTouchingNode(tx, fromId);
  if (touching.length === 0) return result;

  // Running live-prerequisite mesh for the ADR-0034 topology gate. UNBOUNDED read (review R1):
  // cycle detection is only sound against the COMPLETE live prerequisite set — the general-purpose
  // listKnowledgeEdges truncates at LIST_LIMIT=500 (created_at DESC), which beyond 500 edges drops
  // the OLDEST backbone edges and turns a must-reject rewire into a false 'ok'. Same unbounded-scan
  // shape propose_edge.ts uses for its own topology mesh. Freshly read (reflects prior from_ids'
  // rewrites in this tx) and mutated in-memory as we archive/create within THIS call, so two edges
  // that TOGETHER form a cycle are caught.
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
  // Map an endpoint through the FULL merge (every absorbed from_id → intoId), so a loser→loser edge
  // collapses to a self-loop rather than pointing at a just-archived sibling.
  const mapEndpoint = (id: string) => (mergeFromIds.has(id) ? intoId : id);

  for (const edge of touching) {
    const oldFrom = edge.from_knowledge_id;
    const oldTo = edge.to_knowledge_id;
    const newFrom = mapEndpoint(oldFrom);
    const newTo = mapEndpoint(oldTo);

    // Self-loop after rewrite (edge already touched intoId, or a loser→loser edge): the edge
    // collapses — archive-only, no create (a self-edge is never meaningful).
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

    // ADR-0034 topology gate on the REWRITTEN prerequisite edge (pure). reject (cycle / direction
    // contradiction) → THROW → abort the whole merge tx (surfaces the conflict to the human at
    // accept time; spec §4 decision 5b). warn (transitive redundancy) → proceed.
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

    // Archive the old edge (+ fold event), then create the rewritten edge (+ fold event).
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
      // SAVEPOINT: a 23505 from createKnowledgeEdge (the rewritten key already holds the UNIQUE slot)
      // aborts the WHOLE merge tx in Postgres. Wrapping the create + its fold event in a nested tx
      // (savepoint) rolls back ONLY the failed create, keeping the outer merge tx usable — the old
      // edge's archive (written above, outside this savepoint) survives.
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
        // YUK-543 review R2 — `knowledge_edge_unique` is GLOBAL (no partial WHERE), so a 23505 has
        // TWO distinct causes that must not be conflated: a LIVE duplicate (the relationship is
        // already represented → archive-as-duplicate is correct) vs an ARCHIVED TOMBSTONE merely
        // holding the UNIQUE slot (no live duplicate exists — and the source edge is already
        // archived above, so treating it as a duplicate would silently evaporate a live
        // relationship). Disambiguate with a keyed SELECT and REVIVE the tombstone in that case.
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
          // Tombstone → reactivate through the edges.ts throat + anchor a fold-legible
          // generate(create) event to the revived edge id. The fold's create branch re-projects the
          // row as live from that event (created_at/created_by/weight/reasoning refreshed in the
          // row to byte-match the fold output — row == fold holds; see reactivateKnowledgeEdge).
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
          // LIVE duplicate — the relationship survives on the existing edge; the old edge's archive
          // alone is the correct, fold-legible outcome (no create event for the discarded create).
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
 * YUK-543 — repair ALL 9 downstream attribution surfaces for ONE absorbed `fromId` → `intoId`,
 * returning the MergeRepairEntry. The SINGLE source of merge-repair mechanics, shared by merge accept
 * (per from_id in the accept tx) AND scripts/backfill-merge-attribution.ts (per pre-fix orphan) — so
 * the retroactive backfill and the live accept path can never diverge in HOW they repair. `mergeFromIds`
 * is the FULL set of absorbed ids mapping to `intoId` (so loser→loser knowledge_edges collapse rather
 * than dangling). Must run inside a tx.
 */
export async function repairMergeAttributionForFromId(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
  mergeFromIds: ReadonlySet<string>,
): Promise<MergeRepairEntryT> {
  // YUK-497 review F1 — global learning-state write lock at ENTRY for every caller of the
  // shared repair path. merge accept already holds it (reentrant no-op); the background
  // merge_attribution_sweep / merge-attribution-backfill txs previously reached it mid-tx
  // AFTER rewireKnowledgeEdges' knowledge_edge locks → G↔knowledge_edge cycle against a
  // live merge accept (PG 40P01 aborting the user-facing side).
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

// =============================================================================
// acceptProposal / dismissProposal — read propose event by id, apply mutation
// (accept) or write rate=dismiss (dismiss). Returns AcceptResult for accept.
// =============================================================================

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

// YUK-471 W1 PR-A2b — the set of knowledge ids an accept TOUCHED, derived from the
// AcceptResult. The accept-time parity assert re-projects EACH and compares against the
// live row the imperative path just wrote (in the same tx):
//   - propose_new → the new node
//   - reparent / archive → the mutated node
//   - merge → into_id (merged_from appended) + each from_id (now archived)
//   - split → from_id (now archived) + each new node
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
      // Exhaustiveness guard — tsconfig has noImplicitReturns OFF, so a new AcceptResult kind
      // would otherwise slip through returning undefined. `never` forces a compile error here
      // until the new kind is handled above. (OCR #580.)
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export async function acceptProposal(db: Db, proposalId: string): Promise<AcceptResult> {
  // Codex P1-F — concurrent double-accept must not produce duplicate apply
  // side effects. The status check (assertNotAlreadyRated) and the mutation
  // apply must share a transaction with SELECT … FOR UPDATE on the propose
  // event row; otherwise two concurrent callers both pass the pre-check and
  // both apply. The row lock serialises callers; the second sees the rate
  // event written by the first and throws not-pending.
  let staleError: Error | null = null;
  try {
    return await db.transaction(async (tx) => {
      // SELECT … FOR UPDATE on the propose event row — concurrent callers
      // serialise here.
      await tx.execute(sql`SELECT id FROM event WHERE id = ${proposalId} FOR UPDATE`);

      const propose = await readProposeEvent(tx, proposalId);
      await assertNotAlreadyRated(tx, proposalId);

      // Reconstruct mutation payload from event shape
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

      // YUK-471 W1 PR-A2b / YUK-728 — the SINGLE materialization timestamp. Existing rows are
      // locked first so timestamp order matches their actual serialized write order, including
      // subject-root rename/reset transactions that share the same knowledge row. The instant is
      // then threaded through (1) applyX and (2) rate=accept for byte-exact fold == row parity.
      // Learning-state repair and revert writers acquire G before knowledge rows.
      // Taking it inside merge preparation would be too late: these row locks are already held.
      if (apply.mutation === 'merge') await acquireLearningStateWriteLock(tx);
      await lockMutationRows(tx, apply);
      const now = new Date();

      let result: AcceptResult;
      let reparentEmbedding: ReparentEmbeddingSnapshot | null = null;
      // YUK-543 — the merge-repair breadcrumb captured during preparation, threaded onto the accept
      // rate event's payload below and used to drive the post-rate learning_item parity assert.
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
          // Capture so we can write the rollback rate event OUTSIDE the
          // transaction (the tx is about to roll back; we want the rollback
          // marker to survive). The outer catch handles the write.
          staleError = e as Error;
        }
        throw e;
      }

      // YUK-471 W1 PR-A2b — thread the minted node ids onto the rate=accept event
      // AND into the reverse index, both in THIS tx. The minted ids are the only
      // record of which knowledge.id a propose_new / split materialized (the propose
      // event itself never carried them). materialized_ids on the rate payload lets
      // the node reducer reproduce those ids on replay; the materialized_id_index
      // row gives the reducer's reverse lookup (nodeId → anchor propose event) so a
      // node folded BY its id finds where replay starts.
      //   - propose_new_applied → { knowledge: [new_node_id] }
      //   - split_applied       → { knowledge: new_node_ids } (N minted)
      //   - reparent/merge/archive → no minted ids (omit materialized_ids entirely)
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

      // Same-tx reverse-index write — anchor = the propose event id (proposalId).
      // The node reducer's Q2 resolves a minted nodeId → this anchor, then gathers
      // `id = anchor OR caused_by = anchor` (= the propose event + its accepting
      // rate, which carries materialized_ids). First-write-wins / idempotent.
      for (const mintedId of mintedKnowledgeIds) {
        await upsertMaterializedIdIndex(tx, {
          materialized_id: mintedId,
          anchor_event_id: proposalId,
          subject_kind: 'knowledge',
        });
      }

      // Apply succeeded — write rate=accept event chained to the propose event.
      // created_at = the shared `now` (same instant the row was stamped) so
      // fold(events) == row reproduces created_at/updated_at exactly.
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
      // Write the rollback marker post-rollback so subsequent reads see
      // status='stale' rather than perpetual pending. Best-effort.
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

  // Codex P2-I — verify the event is actually a proposal, not just any
  // event id. Without this guard, calling dismiss on, e.g., an attempt
  // event id would still write a rate event chained to it — state pollution.
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
