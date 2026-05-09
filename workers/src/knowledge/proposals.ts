import type { D1Database } from '@cloudflare/workers-types';
import { createId } from '@paralleldrive/cuid2';

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
  payload: string;
  reasoning: string;
  status: string;
  proposed_at: number;
  decided_at: number | null;
}

export interface WriteProposalEntry {
  payload: KnowledgeMutationPayload;
  reasoning: string;
}

export async function writeDreamingProposal(
  db: D1Database,
  entry: WriteProposalEntry,
): Promise<string> {
  const id = createId();
  const proposedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `insert into dreaming_proposal (id, kind, payload, reasoning, status, proposed_at) values (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      'knowledge',
      JSON.stringify(entry.payload),
      entry.reasoning,
      'pending',
      proposedAt,
    )
    .run();
  return id;
}

/**
 * Apply propose_new: insert a new knowledge row.
 * Returns the new node id.
 *
 * - parent_id=null → new ROOT node, domain='wenyan' (Phase 1a single domain)
 * - parent_id!=null → child node, domain=null (inherit from parent chain)
 */
export async function applyProposeNew(
  db: D1Database,
  payload: ProposeNewPayload,
): Promise<string> {
  const newId = createId();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `insert into knowledge (
        id, name, domain, parent_id, base_mastery, ai_delta_mastery,
        merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId,
      payload.name,
      payload.parent_id === null ? 'wenyan' : null,
      payload.parent_id,
      0,
      0,
      '[]',
      1,
      'approved',
      now,
      now,
      0,
    )
    .run();
  return newId;
}

export type AcceptResult = { kind: 'propose_new_applied'; new_node_id: string };

/**
 * Accept proposal: only propose_new in PR A.
 * Reparent / merge / split / archive 留 PR B。
 */
export async function acceptProposal(
  db: D1Database,
  proposalId: string,
): Promise<AcceptResult> {
  const row = await db
    .prepare(
      `select id, kind, payload, reasoning, status, proposed_at, decided_at from dreaming_proposal where id = ?`,
    )
    .bind(proposalId)
    .first<DreamingProposalRow>();
  if (!row) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  if (row.status !== 'pending') {
    throw new Error(`proposal ${proposalId} is not pending (status=${row.status})`);
  }
  const payload = JSON.parse(row.payload) as KnowledgeMutationPayload;
  if (payload.mutation !== 'propose_new') {
    throw new Error(`PR A only supports propose_new accept; got ${payload.mutation}`);
  }
  const newId = await applyProposeNew(db, payload);
  const decidedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(`update dreaming_proposal set status = ?, decided_at = ? where id = ?`)
    .bind('accepted', decidedAt, proposalId)
    .run();
  return { kind: 'propose_new_applied', new_node_id: newId };
}

export async function dismissProposal(db: D1Database, proposalId: string): Promise<void> {
  const decidedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(`update dreaming_proposal set status = ?, decided_at = ? where id = ?`)
    .bind('dismissed', decidedAt, proposalId)
    .run();
}
