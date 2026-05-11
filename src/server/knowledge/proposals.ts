import type { Db } from '@/db/client';
import { dreaming_proposal, knowledge } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Knowledge mutation payloads — discriminated union on `mutation` field.
 * dreaming_proposal.kind 永远 'knowledge'，具体 mutation 类型在 payload.mutation。
 */
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

export interface DreamingProposalRow {
  id: string;
  kind: string;
  payload: unknown;
  reasoning: string;
  status: string;
  proposed_at: Date;
  decided_at: Date | null;
}

export interface WriteProposalEntry {
  payload: KnowledgeMutationPayload;
  reasoning: string;
}

export async function writeDreamingProposal(db: Db, entry: WriteProposalEntry): Promise<string> {
  const id = createId();
  const proposedAt = new Date();
  await db.insert(dreaming_proposal).values({
    id,
    kind: 'knowledge',
    payload: entry.payload as Record<string, unknown>,
    reasoning: entry.reasoning,
    status: 'pending',
    proposed_at: proposedAt,
  });
  return id;
}

async function assertParentExists(db: Db, parentId: string): Promise<void> {
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

/**
 * Apply propose_new: insert a new knowledge row.
 * Returns the new node id.
 *
 * PR A scope: only **child** nodes (parent_id !== null). Root creation rejected — would
 * silently default domain to 'wenyan' and bake in single-domain assumption. Phase 2 multi-domain
 * will need an explicit `domain` field on root proposals; lifting this guard then is the right time.
 */
export async function applyProposeNew(db: Db, payload: ProposeNewPayload): Promise<string> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId = createId();
  const now = new Date();
  await db.insert(knowledge).values({
    id: newId,
    name: payload.name,
    domain: null,
    parent_id: payload.parent_id,
    base_mastery: 0,
    ai_delta_mastery: 0,
    merged_from: [],
    proposed_by_ai: true,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return newId;
}

export type AcceptResult =
  | { kind: 'propose_new_applied'; new_node_id: string }
  | { kind: 'reparent_applied'; node_id: string; new_parent_id: string }
  | { kind: 'merge_applied'; into_id: string; archived_ids: string[] }
  | { kind: 'split_applied'; archived_id: string; new_node_ids: string[] }
  | { kind: 'archive_applied'; node_id: string };

/**
 * Accept proposal: dispatches over all 5 mutation kinds.
 *
 * Runs inside a Drizzle transaction for atomicity.
 */
export async function acceptProposal(db: Db, proposalId: string): Promise<AcceptResult> {
  const row = (
    await db.select().from(dreaming_proposal).where(eq(dreaming_proposal.id, proposalId)).limit(1)
  )[0];
  if (!row) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  if (row.status !== 'pending') {
    throw new Error(`proposal ${proposalId} is not pending (status=${row.status})`);
  }
  const payload = row.payload as KnowledgeMutationPayload;

  switch (payload.mutation) {
    case 'propose_new':
      return await acceptProposeNew(db, proposalId, payload);
    case 'reparent': {
      const reparentPayload = payload as ReparentPayload;
      return await acceptHighTier(db, proposalId, async () => {
        await applyReparent(db, reparentPayload);
        if (reparentPayload.new_parent_id === null) {
          throw new Error('reparent payload must have new_parent_id');
        }
        return {
          kind: 'reparent_applied',
          node_id: reparentPayload.node_id,
          new_parent_id: reparentPayload.new_parent_id,
        };
      });
    }
    case 'merge':
      return await acceptHighTier(db, proposalId, async () => {
        await applyMerge(db, payload);
        return {
          kind: 'merge_applied',
          into_id: payload.into_id,
          archived_ids: payload.from_ids,
        };
      });
    case 'split':
      return await acceptHighTier(db, proposalId, async () => {
        const newIds = await applySplit(db, payload);
        return {
          kind: 'split_applied',
          archived_id: payload.from_id,
          new_node_ids: newIds,
        };
      });
    case 'archive':
      return await acceptHighTier(db, proposalId, async () => {
        await applyArchive(db, payload);
        return { kind: 'archive_applied', node_id: payload.node_id };
      });
    default: {
      const _exhaustive: never = payload;
      void _exhaustive;
      const kind = (payload as { mutation?: unknown }).mutation;
      throw new Error(
        `unknown_mutation: proposal ${proposalId} payload mutation=${JSON.stringify(kind)}`,
      );
    }
  }
}

async function markProposalStale(db: Db, proposalId: string): Promise<void> {
  const now = new Date();
  await db
    .update(dreaming_proposal)
    .set({ status: 'stale', decided_at: now })
    .where(and(eq(dreaming_proposal.id, proposalId), eq(dreaming_proposal.status, 'pending')));
}

async function acceptHighTier(
  db: Db,
  proposalId: string,
  apply: () => Promise<AcceptResult>,
): Promise<AcceptResult> {
  let result: AcceptResult;
  try {
    result = await apply();
  } catch (e) {
    const msg = (e as Error).message;
    if (/^stale/i.test(msg)) {
      await markProposalStale(db, proposalId);
    }
    throw e;
  }
  const now = new Date();
  const updated = await db
    .update(dreaming_proposal)
    .set({ status: 'accepted', decided_at: now })
    .where(and(eq(dreaming_proposal.id, proposalId), eq(dreaming_proposal.status, 'pending')));
  const changes = (updated as { count?: number }).count ?? 0;
  if (changes !== 1) {
    throw new Error(`proposal ${proposalId} was concurrently decided`);
  }
  return result;
}

async function acceptProposeNew(
  db: Db,
  proposalId: string,
  payload: ProposeNewPayload,
): Promise<AcceptResult> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId = createId();
  const now = new Date();
  // Race-safe: use transaction to atomically insert knowledge + update proposal
  return await db.transaction(async (tx) => {
    // Check proposal is still pending inside transaction
    const currentProposal = (
      await tx
        .select({ status: dreaming_proposal.status })
        .from(dreaming_proposal)
        .where(eq(dreaming_proposal.id, proposalId))
        .limit(1)
    )[0];
    if (!currentProposal || currentProposal.status !== 'pending') {
      throw new Error(`proposal ${proposalId} was concurrently decided`);
    }
    await tx.insert(knowledge).values({
      id: newId,
      name: payload.name,
      domain: null,
      parent_id: payload.parent_id,
      base_mastery: 0,
      ai_delta_mastery: 0,
      merged_from: [],
      proposed_by_ai: true,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const updated = await tx
      .update(dreaming_proposal)
      .set({ status: 'accepted', decided_at: now })
      .where(and(eq(dreaming_proposal.id, proposalId), eq(dreaming_proposal.status, 'pending')));
    const changes = (updated as { count?: number }).count ?? 0;
    if (changes !== 1) {
      throw new Error(`proposal ${proposalId} was concurrently decided`);
    }
    return { kind: 'propose_new_applied', new_node_id: newId };
  });
}

/**
 * Apply reparent: change a node's parent_id under optimistic lock.
 */
export async function applyReparent(db: Db, payload: ReparentPayload): Promise<void> {
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

/**
 * Apply archive: soft-delete a node by setting archived_at + bumping version.
 */
export async function applyArchive(db: Db, payload: ArchivePayload): Promise<void> {
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

/**
 * Apply split: archive from_id + insert N new children.
 */
export async function applySplit(db: Db, payload: SplitPayload): Promise<string[]> {
  for (const entry of payload.into) {
    if (entry.parent_id === null) {
      throw new Error(
        'PR B: split into root (parent_id=null) not supported in Phase 1a single-domain',
      );
    }
    await assertParentExists(db, entry.parent_id);
  }
  const now = new Date();
  const newIds: string[] = payload.into.map(() => createId());

  return await db.transaction(async (tx) => {
    // Archive the source node
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
    // Insert new children
    for (let i = 0; i < payload.into.length; i++) {
      const entry = payload.into[i];
      await tx.insert(knowledge).values({
        id: newIds[i],
        name: entry.name,
        domain: null,
        parent_id: entry.parent_id,
        base_mastery: 0,
        ai_delta_mastery: 0,
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

/**
 * Apply merge: archive all from_ids + push their ids onto into.merged_from JSON array.
 */
export async function applyMerge(db: Db, payload: MergePayload): Promise<void> {
  if (payload.from_ids.includes(payload.into_id)) {
    throw new Error(`merge: into_id (${payload.into_id}) cannot also appear in from_ids`);
  }
  for (const fromId of payload.from_ids) {
    if (!(fromId in payload.expected_versions)) {
      throw new Error(`merge: expected_versions missing entry for ${fromId}`);
    }
  }
  const now = new Date();

  await db.transaction(async (tx) => {
    // Check into node exists and is not archived
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

    // Archive each from_id
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

    // Append from_ids to into.merged_from using Postgres jsonb concatenation
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

/**
 * Dismiss proposal. Idempotent on already-dismissed.
 */
export async function dismissProposal(db: Db, proposalId: string): Promise<void> {
  const decidedAt = new Date();
  await db
    .update(dreaming_proposal)
    .set({ status: 'dismissed', decided_at: decidedAt })
    .where(and(eq(dreaming_proposal.id, proposalId), eq(dreaming_proposal.status, 'pending')));
}
