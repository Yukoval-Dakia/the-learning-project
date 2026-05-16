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

import type { Db, Tx } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { newId } from '@/core/ids';
import { writeEvent } from '@/server/events/queries';
import { and, eq, isNull, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

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
  if (entry.payload.mutation === 'propose_new') {
    // Lane B ProposeKnowledge — payload locked to { name, parent_id, reasoning }.
    // parent_id is required (Lane B forbids null); PR A scope already enforced
    // parent_id non-null at the apply step; here we surface as a TypeError.
    if (entry.payload.parent_id === null) {
      throw new Error(
        'writeKnowledgeProposeEvent: propose_new with parent_id=null not supported (PR A scope)',
      );
    }
    await writeEvent(db, {
      id,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge',
      // subject_id is a synthetic id of the proposed knowledge node — the row
      // doesn't exist yet (it's a proposal); accept materialises the row.
      subject_id: newId(),
      outcome: 'partial', // 'partial' = pending; 'success' = accepted (set by rate handler)
      payload: {
        name: entry.payload.name,
        parent_id: entry.payload.parent_id,
        reasoning,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    return id;
  }

  // Other mutations (reparent / merge / split / archive) → experimental:knowledge_<mutation>.
  // The ExperimentalEvent escape hatch accepts any payload record.
  const action = `experimental:knowledge_${entry.payload.mutation}` as const;
  const { mutation: _omit, ...rest } = entry.payload;
  void _omit;
  await writeEvent(db, {
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action,
    subject_kind: 'knowledge',
    // For non-propose_new mutations we have a concrete node_id (or from_id /
    // into_id) — use the most-natural anchor.
    subject_id:
      'node_id' in entry.payload
        ? entry.payload.node_id
        : 'into_id' in entry.payload
          ? entry.payload.into_id
          : 'from_id' in entry.payload
            ? entry.payload.from_id
            : newId(),
    outcome: 'partial',
    payload: {
      ...rest,
      reasoning,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
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
  if (
    row.action !== 'propose' &&
    !row.action.startsWith('experimental:knowledge_')
  ) {
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
  const propose = await readProposeEvent(db, proposalId);
  await assertNotAlreadyRated(db, proposalId);

  // Reconstruct mutation payload from event shape
  const mutationKind: string = propose.action === 'propose'
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
        const newNodeId = await applyProposeNew(db, apply);
        result = { kind: 'propose_new_applied', new_node_id: newNodeId };
        break;
      }
      case 'reparent': {
        await applyReparent(db, apply);
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
        await applyArchive(db, apply);
        result = { kind: 'archive_applied', node_id: apply.node_id };
        break;
      }
      case 'merge': {
        await applyMerge(db, apply);
        result = {
          kind: 'merge_applied',
          into_id: apply.into_id,
          archived_ids: apply.from_ids,
        };
        break;
      }
      case 'split': {
        const newIds = await applySplit(db, apply);
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
      // Mirror legacy behaviour: record a rollback rate event on stale apply
      // so subsequent reads see status='stale' rather than perpetual pending.
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

  // Apply succeeded — write rate=accept event chained to the propose event.
  await writeEvent(db, {
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

  // Verify the propose event exists before writing the rate event
  const proposeRows = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  if (proposeRows.length === 0) {
    throw new Error(`proposal not found: ${proposalId}`);
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
