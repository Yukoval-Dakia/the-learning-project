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

async function assertParentExists(db: D1Database, parentId: string): Promise<void> {
  const row = await db
    .prepare(`select id from knowledge where id = ? and archived_at is null`)
    .bind(parentId)
    .first<{ id: string }>();
  if (!row) {
    throw new Error(`parent knowledge node not found or archived: ${parentId}`);
  }
}

// Build the "insert into knowledge" prepared statement for a propose_new payload.
// Used by the standalone applyProposeNew path. acceptProposal uses a conditional
// INSERT…SELECT…WHERE EXISTS variant inline so it can race-guard against a concurrent decide.
function buildKnowledgeInsert(
  db: D1Database,
  payload: ProposeNewPayload,
  newId: string,
  now: number,
) {
  return db
    .prepare(
      `insert into knowledge (
        id, name, domain, parent_id, base_mastery, ai_delta_mastery,
        merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId,
      payload.name,
      null, // child node: domain inherits via getEffectiveDomain. PR A rejects parent_id=null.
      payload.parent_id,
      0,
      0,
      '[]',
      1,
      'approved',
      now,
      now,
      0,
    );
}

/**
 * Apply propose_new: insert a new knowledge row.
 * Returns the new node id.
 *
 * PR A scope: only **child** nodes (parent_id !== null). Root creation rejected — would
 * silently default domain to 'wenyan' and bake in single-domain assumption. Phase 2 multi-domain
 * will need an explicit `domain` field on root proposals; lifting this guard then is the right time.
 */
export async function applyProposeNew(
  db: D1Database,
  payload: ProposeNewPayload,
): Promise<string> {
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId = createId();
  const now = Math.floor(Date.now() / 1000);
  await buildKnowledgeInsert(db, payload, newId, now).run();
  return newId;
}

export type AcceptResult = { kind: 'propose_new_applied'; new_node_id: string };

/**
 * Accept proposal: only propose_new in PR A.
 * Reparent / merge / split / archive 留 PR B。
 *
 * Race-safe: the INSERT is gated on `dreaming_proposal.status = 'pending'` via INSERT…SELECT…
 * WHERE EXISTS, and the UPDATE carries the same guard. Two concurrent accepts can both pass the
 * pre-read but only one batch will actually mutate; the loser's INSERT and UPDATE are both no-ops
 * (no orphan knowledge row) and we surface the loss via the post-batch row-count check.
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
  if (payload.parent_id === null) {
    throw new Error(
      'PR A: propose_new with parent_id=null (root creation) not supported; Phase 2 multi-domain will allow it',
    );
  }
  await assertParentExists(db, payload.parent_id);
  const newId = createId();
  const now = Math.floor(Date.now() / 1000);
  const conditionalInsert = db
    .prepare(
      `insert into knowledge (
        id, name, domain, parent_id, base_mastery, ai_delta_mastery,
        merged_from, proposed_by_ai, approval_status, created_at, updated_at, version
      )
      select ?, ?, NULL, ?, 0, 0, '[]', 1, 'approved', ?, ?, 0
      where exists (select 1 from dreaming_proposal where id = ? and status = 'pending')`,
    )
    .bind(newId, payload.name, payload.parent_id, now, now, proposalId);
  const guardedUpdate = db
    .prepare(
      `update dreaming_proposal set status = ?, decided_at = ? where id = ? and status = 'pending'`,
    )
    .bind('accepted', now, proposalId);
  const results = await db.batch([conditionalInsert, guardedUpdate]);
  const updateChanges = (results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes;
  if (updateChanges !== 1) {
    throw new Error(`proposal ${proposalId} was concurrently decided`);
  }
  return { kind: 'propose_new_applied', new_node_id: newId };
}

/**
 * Apply reparent: change a node's parent_id under optimistic lock.
 *
 * Phase 1a single-domain: rejects new_parent_id=null (root creation) — same guard
 * as applyProposeNew. When the node was a root (parent_id IS NULL, domain set),
 * the UPDATE also clears domain so the inheritance invariant holds.
 */
export async function applyReparent(
  db: D1Database,
  payload: ReparentPayload,
): Promise<void> {
  if (payload.new_parent_id === null) {
    throw new Error(
      'PR B: reparent to root (new_parent_id=null) not supported in Phase 1a single-domain',
    );
  }
  await assertParentExists(db, payload.new_parent_id);
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `update knowledge
        set parent_id = ?, domain = NULL, updated_at = ?, version = version + 1
        where id = ? and version = ? and archived_at is null`,
    )
    .bind(payload.new_parent_id, now, payload.node_id, payload.expected_version)
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes !== 1) {
    throw new Error(`stale: knowledge ${payload.node_id} version mismatch or archived`);
  }
}

/**
 * Dismiss proposal. Idempotent on already-dismissed (status guard prevents repeated decided_at flips).
 */
export async function dismissProposal(db: D1Database, proposalId: string): Promise<void> {
  const decidedAt = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `update dreaming_proposal set status = ?, decided_at = ? where id = ? and status = 'pending'`,
    )
    .bind('dismissed', decidedAt, proposalId)
    .run();
}
