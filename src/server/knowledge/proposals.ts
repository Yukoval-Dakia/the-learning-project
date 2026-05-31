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

import { newId } from '@/core/ids';
import type { SuggestionKindT } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { writeArchiveProposal } from '@/server/proposals/producers';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq, isNull, sql } from 'drizzle-orm';

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

export async function applyProposeNew(db: DbLike, payload: ProposeNewPayload): Promise<string> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId_ = newId();
  const now = new Date();
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
  return newId_;
}

export async function applyReparent(db: DbLike, payload: ReparentPayload): Promise<void> {
  if (payload.new_parent_id === null) {
    throw new Error(
      'PR B: reparent to root (new_parent_id=null) not supported in Phase 1a single-domain',
    );
  }
  await assertParentExists(db, payload.new_parent_id);
  const now = new Date();
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
}

export async function applyArchive(db: DbLike, payload: ArchivePayload): Promise<void> {
  const now = new Date();
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

export async function applySplit(db: DbLike, payload: SplitPayload): Promise<string[]> {
  for (const entry of payload.into) {
    if (entry.parent_id === null) {
      throw new Error(
        'PR B: split into root (parent_id=null) not supported in Phase 1a single-domain',
      );
    }
    await assertParentExists(db, entry.parent_id);
  }
  const now = new Date();
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

export async function applyMerge(db: DbLike, payload: MergePayload): Promise<void> {
  if (payload.from_ids.includes(payload.into_id)) {
    throw new Error(`merge: into_id (${payload.into_id}) cannot also appear in from_ids`);
  }
  for (const fromId of payload.from_ids) {
    if (!(fromId in payload.expected_versions)) {
      throw new Error(`merge: expected_versions missing entry for ${fromId}`);
    }
  }
  const now = new Date();

  await (db as Db).transaction(async (tx) => {
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
  });
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

      let result: AcceptResult;
      try {
        switch (apply.mutation) {
          case 'propose_new': {
            const newNodeId = await applyProposeNew(tx, apply);
            result = { kind: 'propose_new_applied', new_node_id: newNodeId };
            break;
          }
          case 'reparent': {
            await applyReparent(tx, apply);
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
            await applyArchive(tx, apply);
            result = { kind: 'archive_applied', node_id: apply.node_id };
            break;
          }
          case 'merge': {
            await applyMerge(tx, apply);
            result = {
              kind: 'merge_applied',
              into_id: apply.into_id,
              archived_ids: apply.from_ids,
            };
            break;
          }
          case 'split': {
            const newIds = await applySplit(tx, apply);
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

      // Apply succeeded — write rate=accept event chained to the propose event.
      await writeEvent(tx, {
        id: newId(),
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: { rating: 'accept' },
        caused_by_event_id: proposalId,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });

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
