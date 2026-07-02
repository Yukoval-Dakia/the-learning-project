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
// chained via caused_by_event_id = propose event id. The mutation apply step
// (insert/update knowledge rows) happens transactionally with the rate event
// write to keep accept atomic.

import { updateGoalScope } from '@/capabilities/agency/server/goals/queries';
import { newId } from '@/core/ids';
import { applyKnowledgeMergeToIds } from '@/core/projections/learning_item';
import type { MergeRepairEntryT, SuggestionKindT } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, goal, knowledge, learning_item, misconception_edge, question } from '@/db/schema';
import { embedHash, knowledgeEmbedText } from '@/server/ai/embed-source';
import { retireLearnerAxisStateOnMerge } from '@/server/calibration/axis-writer';
import { retireKcTypedStateOnMerge } from '@/server/conjectures/typed-state';
import { writeEvent } from '@/server/events/queries';
import { retireFsrsStateOnMerge } from '@/server/fsrs/state';
import { ApiError } from '@/server/http/errors';
import { retireMasteryStateOnMerge } from '@/server/mastery/state';
import { projectKnowledgeNodeGuarded } from '@/server/projections/knowledge';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import {
  assertLearningItemParity,
  learningItemLiveRowToSnapshot,
  learningItemsWithGenesisAnchor,
} from '@/server/projections/parity';
// YUK-471 W1 PR-A2b — accept-time projection parity assert (dev/test throws, prod warns) +
// the applicability gate (skip nodes that predate event-sourcing — no genesis anchor → fold
// is null → not a real mismatch; the backfill establishes those anchors later).
import {
  assertKnowledgeNodeParity,
  knowledgeLiveRowToSnapshot,
  knowledgeNodesWithGenesisAnchor,
} from '@/server/projections/parity';
// YUK-471 W1 PR-B1 — the SoT-flip gate (default OFF; projection becomes the row writer when ON).
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { writeArchiveProposal } from '@/server/proposals/producers';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getEffectiveDomain } from './domain';
import {
  archiveKnowledgeEdge,
  createKnowledgeEdge,
  listKnowledgeEdges,
  listLiveEdgesTouchingNode,
} from './edges';
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

// YUK-471 W1 PR-A2b — `now` is the SINGLE accept-time timestamp the caller stamps
// the row with. Defaulted to `new Date()` so the other (non-accept) callers
// (tag-knowledge.ts, tests) keep working; acceptProposal passes its tx-scoped
// `now` so the row's created_at/updated_at === the rate=accept event's created_at
// === what the node reducer stamps from (fold(events) == row byte-exact).
export async function applyProposeNew(
  db: DbLike,
  payload: ProposeNewPayload,
  now: Date = new Date(),
  // YUK-471 W1 PR-B1 — when false (SoT flip ON), validate + mint but SKIP the imperative
  // INSERT; the projection write-through writes the row from events at the accept seam. The
  // minted node is event-sourced THIS tx (propose + rate + index anchor), so its fold is
  // non-null — projectKnowledgeNode never hits its delete-on-null branch (zero delete risk).
  writeRow = true,
): Promise<string> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId_ = newId();
  if (writeRow) {
    await db.insert(knowledge).values({
      id: newId_,
      name: payload.name,
      domain: null,
      parent_id: payload.parent_id,
      merged_from: [],
      proposed_by_ai: true,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  return newId_;
}

export async function applyReparent(
  db: DbLike,
  payload: ReparentPayload,
  now: Date = new Date(),
): Promise<void> {
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
    .select({ name: knowledge.name, hash: knowledge.embed_content_hash })
    .from(knowledge)
    .where(eq(knowledge.id, payload.node_id))
    .limit(1);
  const moved = beforeRows[0];

  const result = await db
    .update(knowledge)
    .set({
      parent_id: payload.new_parent_id,
      domain: null,
      updated_at: now,
      version: sql`${knowledge.version} + 1`,
    })
    .where(
      and(
        eq(knowledge.id, payload.node_id),
        eq(knowledge.version, payload.expected_version),
        isNull(knowledge.archived_at),
      ),
    );
  const changes = (result as { count?: number }).count ?? 0;
  if (changes !== 1) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or archived`);
  }

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
      newEffectiveDomain = await getEffectiveDomain(db, payload.node_id);
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
        .set({ embedding: null, embed_content_hash: newHash, updated_at: now })
        .where(eq(knowledge.id, payload.node_id));
    }
  }
}

export async function applyArchive(
  db: DbLike,
  payload: ArchivePayload,
  now: Date = new Date(),
): Promise<void> {
  const result = await db
    .update(knowledge)
    .set({ archived_at: now, updated_at: now, version: sql`${knowledge.version} + 1` })
    .where(
      and(
        eq(knowledge.id, payload.node_id),
        eq(knowledge.version, payload.expected_version),
        isNull(knowledge.archived_at),
      ),
    );
  const changes = (result as { count?: number }).count ?? 0;
  if (changes !== 1) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or already archived`);
  }
}

export async function applySplit(
  db: DbLike,
  payload: SplitPayload,
  now: Date = new Date(),
): Promise<string[]> {
  for (const entry of payload.into) {
    if (entry.parent_id === null) {
      throw new Error(
        'PR B: split into root (parent_id=null) not supported in Phase 1a single-domain',
      );
    }
    await assertParentExists(db, entry.parent_id);
  }
  const newIds: string[] = payload.into.map(() => newId());

  // Drizzle transaction (the API surface uses Db; transaction wrapping below
  // works for both top-level db and Tx — Tx call is a no-op nested transaction).
  return await (db as Db).transaction(async (tx) => {
    const archiveResult = await tx
      .update(knowledge)
      .set({ archived_at: now, updated_at: now, version: sql`${knowledge.version} + 1` })
      .where(
        and(
          eq(knowledge.id, payload.from_id),
          eq(knowledge.version, payload.expected_version),
          isNull(knowledge.archived_at),
        ),
      );
    const archiveChanges = (archiveResult as { count?: number }).count ?? 0;
    if (archiveChanges !== 1) {
      throw new Error(`stale: knowledge ${payload.from_id} version mismatch or already archived`);
    }
    for (let i = 0; i < payload.into.length; i++) {
      const entry = payload.into[i];
      await tx.insert(knowledge).values({
        id: newIds[i],
        name: entry.name,
        domain: null,
        parent_id: entry.parent_id,
        merged_from: [],
        proposed_by_ai: true,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }
    return newIds;
  });
}

// =============================================================================
// YUK-543 — merge attribution repair. When a KC merge is accepted, applyMerge now
// repairs 9 downstream attribution surfaces per absorbed from_id (in addition to the
// original knowledge-row archive + merged_from append), returning a forensic
// MergeRepairEntry[] the accept path pins on its rate event. See the diff-level plan
// in docs/design/2026-07-02-kc-dedup-attribution-rewrite-spec.md §2.
//
// DELIBERATELY LEFT STALE (documented, not silent): learning_session.scope_knowledge_ids
// (schema.ts:757-762) — an in-flight placement probe holding an absorbed KC just skips it
// for that session's remaining duration (session-ephemeral, spec §2 table).
// =============================================================================

// question.knowledge_ids — imperative (no fold). Rewrite every question tagged with fromId.
async function rewriteQuestionKnowledgeIds(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`);
  const rewritten: string[] = [];
  for (const r of rows) {
    const next = applyKnowledgeMergeToIds(r.knowledge_ids ?? [], new Set([fromId]), intoId);
    await tx.update(question).set({ knowledge_ids: next }).where(eq(question.id, r.id));
    rewritten.push(r.id);
  }
  return rewritten;
}

// learning_item.knowledge_ids — fold-owned (flag OFF today), event-native via the SHARED
// experimental:knowledge_merge event (gather Q3 + reducer branch). Here we keep the imperative
// UPDATE (OFF path = imperative row is SoT); the merge accept event + gather/reducer make the fold
// reproduce it. ONLY knowledge_ids changes (no version/updated_at bump — mirrors the reducer's
// no-bump branch, spec §2). Parity is asserted by acceptProposal AFTER the rate event is written
// (the fold gates the rewrite on the merge's acceptance, which is not visible until then).
async function rewriteLearningItemKnowledgeIds(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: learning_item.id, knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(sql`${learning_item.knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`);
  const rewritten: string[] = [];
  for (const r of rows) {
    const next = applyKnowledgeMergeToIds(r.knowledge_ids ?? [], new Set([fromId]), intoId);
    await tx.update(learning_item).set({ knowledge_ids: next }).where(eq(learning_item.id, r.id));
    rewritten.push(r.id);
  }
  return rewritten;
}

// goal.scope_knowledge_ids — fold-owned (flag OFF today), event-native by REUSING the existing
// experimental:goal_scope_update writer (updateGoalScope) per affected goal. That writer emits the
// fold-visible event, does the row write, runs the flip-guard + its own parity assert — so no
// separate assert is needed here.
async function rewriteGoalScopeOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .select({ id: goal.id, scope_knowledge_ids: goal.scope_knowledge_ids })
    .from(goal)
    .where(sql`${goal.scope_knowledge_ids} @> ${JSON.stringify([fromId])}::jsonb`);
  const rewritten: string[] = [];
  for (const r of rows) {
    const next = applyKnowledgeMergeToIds(r.scope_knowledge_ids ?? [], new Set([fromId]), intoId);
    await updateGoalScope(tx, r.id, { scope_knowledge_ids: next }, now);
    rewritten.push(r.id);
  }
  return rewritten;
}

// misconception_edge.to_id (to_kind='knowledge') — imperative, no fold, dark
// (MISCONCEPTION_PROMOTE_ENABLED OFF). Re-point every live edge whose knowledge TARGET is fromId.
// The UNIQUE(from_kind,from_id,to_kind,to_id,relation_type) index is honored: if re-pointing would
// collide with an existing edge (23505), archive the source edge instead (archive-as-duplicate).
async function rewireMisconceptionEdgeTargets(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .select({ id: misconception_edge.id })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.to_kind, 'knowledge'),
        eq(misconception_edge.to_id, fromId),
        isNull(misconception_edge.archived_at),
      ),
    );
  const handled: string[] = [];
  for (const r of rows) {
    try {
      // SAVEPOINT: a UNIQUE(from,from_id,to_kind,to_id,relation_type) violation on the rewrite would
      // abort the WHOLE merge tx (Postgres aborts on any error). Wrapping in a nested tx (savepoint)
      // rolls back ONLY the failed UPDATE, keeping the outer merge tx usable for the archive fallback.
      await tx.transaction(async (sp) => {
        await sp
          .update(misconception_edge)
          .set({ to_id: intoId, updated_at: now })
          .where(eq(misconception_edge.id, r.id));
      });
    } catch (err) {
      const pgCode =
        (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (pgCode === '23505') {
        // A misconception edge with the rewritten target already exists → archive-as-duplicate.
        await tx
          .update(misconception_edge)
          .set({ archived_at: now, updated_at: now })
          .where(eq(misconception_edge.id, r.id));
      } else {
        throw err;
      }
    }
    handled.push(r.id);
  }
  return handled;
}

// ── knowledge_edge (LIVE fold, PROJECTION_IS_WRITER=1) — event-native rewire ─────────────────────
// Mirrors applyEdgeSupersede (propose_edge.ts): archive-old + create-new via the imperative
// edges.ts functions PAIRED with fold-visible `generate` events, so the LIVE edge fold reproduces
// every merge-driven endpoint change (a raw UPDATE would be invisible to the fold → resurrected on
// rebuild). Actor user/self matches the merge accept.

async function writeEdgeArchiveEvent(tx: Tx, edge: TopologyEdge, oldEdgeId: string, now: Date) {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: oldEdgeId,
    outcome: 'success',
    payload: {
      edge_op: 'archive',
      archive_edge_id: oldEdgeId,
      from_knowledge_id: edge.from_knowledge_id,
      to_knowledge_id: edge.to_knowledge_id,
      relation_type: edge.relation_type,
      reasoning: 'merge: KC attribution rewrite (YUK-543)',
    },
    created_at: now,
  });
}

async function writeEdgeCreateEvent(
  tx: Tx,
  newEdgeId: string,
  from: string,
  to: string,
  relationType: string,
  weight: number,
  reasoning: string | null,
  now: Date,
) {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: newEdgeId,
    outcome: 'success',
    payload: {
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: relationType,
      weight,
      reasoning,
    },
    created_at: now,
  });
}

export async function rewireKnowledgeEdges(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
  mergeFromIds: ReadonlySet<string>,
): Promise<Array<{ old_edge_id: string; new_edge_id: string | null }>> {
  const result: Array<{ old_edge_id: string; new_edge_id: string | null }> = [];
  const touching = await listLiveEdgesTouchingNode(tx, fromId);
  if (touching.length === 0) return result;

  // Running live-prerequisite mesh for the ADR-0034 topology gate. Freshly read (reflects prior
  // from_ids' rewrites in this tx) and mutated in-memory as we archive/create within THIS call, so
  // two edges that TOGETHER form a cycle are caught (mirrors propose_edge's liveTopologyEdges).
  const livePrereq: TopologyEdge[] = (
    await listKnowledgeEdges(tx, { relation_type: 'prerequisite' })
  ).map((e) => ({
    from_knowledge_id: e.from_knowledge_id,
    to_knowledge_id: e.to_knowledge_id,
    relation_type: e.relation_type,
  }));
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
    const oldTopo: TopologyEdge = {
      from_knowledge_id: oldFrom,
      to_knowledge_id: oldTo,
      relation_type: edge.relation_type,
    };

    // Self-loop after rewrite (edge already touched intoId, or a loser→loser edge): the edge
    // collapses — archive-only, no create (a self-edge is never meaningful).
    if (newFrom === newTo) {
      await archiveKnowledgeEdge(tx, edge.id, now);
      await writeEdgeArchiveEvent(tx, oldTopo, edge.id, now);
      if (edge.relation_type === 'prerequisite') dropFromMesh(oldFrom, oldTo);
      result.push({ old_edge_id: edge.id, new_edge_id: null });
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
      );
      if (verdict.status === 'reject') {
        throw new Error(
          `merge: knowledge_edge rewire ${edge.id} (${newFrom} --prerequisite--> ${newTo}) ` +
            `rejected by ADR-0034 topology gate=${verdict.gate}: ${verdict.reason} — aborting merge`,
        );
      }
    }

    // Archive the old edge (+ fold event), then create the rewritten edge (+ fold event).
    await archiveKnowledgeEdge(tx, edge.id, now);
    await writeEdgeArchiveEvent(tx, oldTopo, edge.id, now);
    if (edge.relation_type === 'prerequisite') dropFromMesh(oldFrom, oldTo);

    let newEdgeId: string | null = null;
    try {
      // SAVEPOINT: a 23505 from createKnowledgeEdge (the rewritten key already holds the UNIQUE slot)
      // aborts the WHOLE merge tx in Postgres. Wrapping the create + its fold event in a nested tx
      // (savepoint) rolls back ONLY the failed create, keeping the outer merge tx usable — the old
      // edge's archive (written above, outside this savepoint) survives (archive-as-duplicate).
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
        await writeEdgeCreateEvent(
          sp,
          id,
          newFrom,
          newTo,
          edge.relation_type,
          edge.weight,
          edge.reasoning,
          now,
        );
        return id;
      });
      if (edge.relation_type === 'prerequisite') {
        livePrereq.push({
          from_knowledge_id: newFrom,
          to_knowledge_id: newTo,
          relation_type: 'prerequisite',
        });
      }
    } catch (err) {
      // A live/archived edge with the rewritten (from,to,relation_type) already holds the UNIQUE
      // slot (409 conflict), OR the non-into endpoint is archived/missing (404) — either way the
      // relationship is already represented (or degenerate), so the archive alone is the correct,
      // fold-legible outcome (archive-as-duplicate; no create event for the discarded create).
      if (err instanceof ApiError && (err.code === 'conflict' || err.code === 'not_found')) {
        if (err.code === 'not_found') {
          console.warn('[rewireKnowledgeEdges] skipped create (endpoint archived/missing)', {
            edgeId: edge.id,
            newFrom,
            newTo,
          });
        }
        newEdgeId = null;
      } else {
        throw err;
      }
    }
    result.push({ old_edge_id: edge.id, new_edge_id: newEdgeId });
  }
  return result;
}

/**
 * YUK-543 — repair ALL 9 downstream attribution surfaces for ONE absorbed `fromId` → `intoId`,
 * returning the MergeRepairEntry. The SINGLE source of merge-repair mechanics, shared by applyMerge
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
  return {
    from_id: fromId,
    question_ids_rewritten: await rewriteQuestionKnowledgeIds(tx, fromId, intoId),
    learning_item_ids_rewritten: await rewriteLearningItemKnowledgeIds(tx, fromId, intoId),
    goal_ids_rewritten: await rewriteGoalScopeOnMerge(tx, fromId, intoId, now),
    edges_rewired: await rewireKnowledgeEdges(tx, fromId, intoId, now, mergeFromIds),
    mastery_state: await retireMasteryStateOnMerge(tx, fromId, intoId),
    fsrs_state: await retireFsrsStateOnMerge(tx, fromId, intoId),
    axis_state: await retireLearnerAxisStateOnMerge(tx, fromId, intoId),
    kc_typed_state: await retireKcTypedStateOnMerge(tx, fromId, intoId),
    misconception_edges_rewritten: await rewireMisconceptionEdgeTargets(tx, fromId, intoId, now),
  };
}

export async function applyMerge(
  db: DbLike,
  payload: MergePayload,
  now: Date = new Date(),
): Promise<MergeRepairEntryT[]> {
  if (payload.from_ids.includes(payload.into_id)) {
    throw new Error(`merge: into_id (${payload.into_id}) cannot also appear in from_ids`);
  }
  for (const fromId of payload.from_ids) {
    if (!(fromId in payload.expected_versions)) {
      throw new Error(`merge: expected_versions missing entry for ${fromId}`);
    }
  }

  return await (db as Db).transaction(async (tx) => {
    const intoRow = (
      await tx
        .select({ id: knowledge.id, merged_from: knowledge.merged_from })
        .from(knowledge)
        .where(and(eq(knowledge.id, payload.into_id), isNull(knowledge.archived_at)))
        .limit(1)
    )[0];
    if (!intoRow) {
      throw new Error(`stale: merge into_id ${payload.into_id} not found or archived`);
    }
    // Archive every absorbed node FIRST (version-guarded — throws stale on mismatch).
    for (const fromId of payload.from_ids) {
      const archiveResult = await tx
        .update(knowledge)
        .set({ archived_at: now, updated_at: now, version: sql`${knowledge.version} + 1` })
        .where(
          and(
            eq(knowledge.id, fromId),
            eq(knowledge.version, payload.expected_versions[fromId]),
            isNull(knowledge.archived_at),
          ),
        );
      const archiveChanges = (archiveResult as { count?: number }).count ?? 0;
      if (archiveChanges !== 1) {
        throw new Error(`stale: knowledge ${fromId} version mismatch or already archived`);
      }
    }

    // Per-absorbed-from_id attribution repair — deterministic order = payload.from_ids array order.
    const mergeFromIds = new Set(payload.from_ids);
    const repairLog: MergeRepairEntryT[] = [];
    for (const fromId of payload.from_ids) {
      repairLog.push(
        await repairMergeAttributionForFromId(tx, fromId, payload.into_id, now, mergeFromIds),
      );
    }

    const currentMergedFrom = (intoRow.merged_from as string[]) ?? [];
    const newMergedFrom = [...currentMergedFrom, ...payload.from_ids];
    await tx
      .update(knowledge)
      .set({
        merged_from: newMergedFrom,
        updated_at: now,
        version: sql`${knowledge.version} + 1`,
      })
      .where(and(eq(knowledge.id, payload.into_id), isNull(knowledge.archived_at)));

    return repairLog;
  });
}

/**
 * YUK-543 — after a merge accept's rate event is written, assert the learning_item fold reproduces
 * every merge-rewritten row. Runs POST-rate (unlike the goal/node asserts) because the learning_item
 * fold gates its knowledge_ids rewrite on the merge's ACCEPTANCE, which is not fold-visible until the
 * rate=accept event exists. Gated by learningItemsWithGenesisAnchor (a pre-event-sourced item folds
 * to null → would FALSE-mismatch). Dev/test throw, prod warn (parity.ts contract).
 * NOTE for worklist #5: when learning_item's PROJECTION_IS_WRITER flips ON, this merge path must add
 * a projectLearningItemGuarded write-through for these ids (as updateGoalScope does for goal today).
 */
async function assertMergeLearningItemParity(
  tx: Tx,
  repairLog: MergeRepairEntryT[],
): Promise<void> {
  const touched = [...new Set(repairLog.flatMap((e) => e.learning_item_ids_rewritten))];
  if (touched.length === 0) return;
  const anchored = await learningItemsWithGenesisAnchor(tx, touched);
  if (anchored.size === 0) return;
  const rows = await tx.select().from(learning_item).where(inArray(learning_item.id, touched));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of touched) {
    if (!anchored.has(id)) continue;
    const live = byId.get(id);
    await assertLearningItemParity(tx, id, live ? learningItemLiveRowToSnapshot(live) : null);
  }
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

// YUK-471 W1 PR-A2b — read each affected `knowledge` row from THIS tx, project it to the
// structural KnowledgeRowSnapshot shape (drops embed_*, coerces timestamps), and assert
// fold(events) == that row. Read-only gather→fold; dev/test THROW on mismatch, prod
// warn+returns (see parity.ts).
//
// APPLICABILITY GATE: only assert for nodes that are EVENT-SOURCED (have a genesis anchor —
// genesis seed / auto_tag create / materialized_id_index row). A pre-event-sourcing node
// (seed root, legacy pre-W1 row) folds to null because it has no originating event, so a
// reparent/archive/merge of such a node would FALSE-mismatch (fold(null) != live row). Those
// nodes get their anchor from the PR-A2a backfill later; until then they are correctly
// SKIPPED here (the standalone audit:projection + its allowlist own that backfill window).
// A minting accept (propose_new / split) always anchors its new node THIS tx, so those
// always assert.
async function assertAcceptParity(db: DbLike, result: AcceptResult): Promise<void> {
  const ids = affectedNodeIds(result);
  if (ids.length === 0) return;
  const eventSourced = await knowledgeNodesWithGenesisAnchor(db, ids);
  if (eventSourced.size === 0) return;
  const rows = await db.select().from(knowledge).where(inArray(knowledge.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    if (!eventSourced.has(id)) continue; // pre-event-sourcing node — fold can't reproduce it yet
    const live = byId.get(id);
    // knowledgeLiveRowToSnapshot picks the structural fields (drops embed_*) WITHOUT a Zod
    // parse — a .parse() throw here would abort the live accept in prod (hot-path contract).
    // A missing row (should not happen on a successful accept) is passed as null — fold must
    // then also be null for parity to hold.
    const liveSnapshot = live ? knowledgeLiveRowToSnapshot(live) : null;
    await assertKnowledgeNodeParity(db, id, liveSnapshot);
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

      // YUK-471 W1 PR-A2b — the SINGLE accept-time timestamp. Computed ONCE here
      // and threaded through (1) the applyX call (row created_at/updated_at) and
      // (2) the rate=accept event's created_at. One shared `now` is what makes
      // fold(events) == row reproducible byte-exact: the node reducer stamps the
      // projected row from the accept event's created_at, so the live row must be
      // stamped from the same instant. (Sub-ms shift from the old per-applier
      // `new Date()` is the only behavior change for live users.)
      const now = new Date();
      // YUK-471 W1 PR-B — read the SoT-flip gate ONCE per accept. OFF (default): imperative
      // appliers write the row + the A2b parity assert verifies fold==row. ON: the projection
      // is the row writer for EVERY kind the accept touches (propose_new / reparent / archive /
      // merge / split) — propose_new skips its imperative INSERT; the mutation appliers keep
      // their version-guarded UPDATE and the projection overwrites from events (see the seam
      // below). Flag OFF stays the full-verification rollback.
      const flip = projectionIsWriter();

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

      let result: AcceptResult;
      // YUK-543 — the merge-repair breadcrumb captured from applyMerge, threaded onto the accept
      // rate event's payload below and used to drive the post-rate learning_item parity assert.
      let mergeRepair: MergeRepairEntryT[] | null = null;
      try {
        switch (apply.mutation) {
          case 'propose_new': {
            const newNodeId = await applyProposeNew(tx, apply, now, /* writeRow */ !flip);
            result = { kind: 'propose_new_applied', new_node_id: newNodeId };
            break;
          }
          case 'reparent': {
            await applyReparent(tx, apply, now);
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
            await applyArchive(tx, apply, now);
            result = { kind: 'archive_applied', node_id: apply.node_id };
            break;
          }
          case 'merge': {
            mergeRepair = await applyMerge(tx, apply, now);
            result = {
              kind: 'merge_applied',
              into_id: apply.into_id,
              archived_ids: apply.from_ids,
            };
            break;
          }
          case 'split': {
            const newIds = await applySplit(tx, apply, now);
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

      // YUK-471 W1 PR-A2b — accept-time projection parity assert. Runs AFTER the rate
      // write + index write (so the gather sees the chained accept + materialized_ids)
      // and INSIDE this tx (so it reads the just-written rows + events). The imperative
      // write stays the SoT; this proves fold(events) == row for every node the accept
      // touched. Dev/test THROW on divergence (catch reducer bugs immediately); prod
      // warn+returns (never break a live accept over a fold bug — see parity.ts). NOTE
      // the merge into_id node also folds here: its merged_from append + version bump
      // must reproduce.
      // YUK-471 W1 PR-B — the SoT seam. Flag ON: the projection is the row writer for EVERY
      // node the accept touched (affectedNodeIds). GUARDED — a touched node that folds to null
      // but has NO genesis anchor (a seed root / any pre-event-sourced node) is left intact,
      // NEVER deleted (keystone, see knowledge.ts projectKnowledgeNodeGuarded). For propose_new
      // the imperative INSERT was skipped (writeRow=false); the mutation appliers (reparent /
      // archive / merge / split) keep their version-guarded imperative UPDATE and the projection
      // overwrites it from events (last-write-wins for an event-sourced node, skipped for a
      // blind one). This runs AFTER the rate + materialized_id_index writes, in the same tx, so
      // the fold sees them — the exact point the A2b parity assert ran. Flag OFF keeps that
      // assert (true rollback: full fold==row verification restored).
      if (flip) {
        for (const id of affectedNodeIds(result)) {
          await projectKnowledgeNodeGuarded(tx, id);
        }
      } else {
        await assertAcceptParity(tx, result);
      }

      // YUK-543 — merge-only: verify the learning_item fold reproduces the merge-rewritten rows.
      // Runs in BOTH flip branches (learning_item is governed by its OWN, still-OFF flag) and AFTER
      // the rate write (the fold gates its rewrite on the merge's now-written acceptance).
      if (mergeRepair) {
        await assertMergeLearningItemParity(tx, mergeRepair);
      }

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
