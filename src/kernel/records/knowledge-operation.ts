// DB-side discovery and fact addressing for the v1 `knowledge_operation` rate
// fact. The strict shape decode lives in @/core/projections/knowledge-operation;
// this side scans the raw rate rows before any id filtering (a malformed key is
// unattributable, so the whole knowledge scan fails closed) and verifies that
// every referenced fact — fact events, the retracted accept, the correction —
// exists and matches what the operation declares.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  KNOWLEDGE_OPERATION_KEY,
  type KnowledgeOperationTarget,
  type KnowledgeOperationV1,
  UndecodableKnowledgeOperationError,
  decodeKnowledgeOperation,
} from '@/core/projections/knowledge-operation';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

export interface KnowledgeOperationEntry {
  rate: EventRow;
  op: KnowledgeOperationV1;
}

export interface KnowledgeOperationScan {
  /** rate event id → row + decoded operation. */
  byRateId: Map<string, KnowledgeOperationEntry>;
  /** `${kind}:${id}` → rate event ids declaring the entity as a target. */
  targetsByEntity: Map<string, string[]>;
}

export interface KnowledgeOperationContext {
  scan: KnowledgeOperationScan;
  /** Referenced envelopes loaded for verification (facts, accepts, proposals, corrections). */
  facts: Map<string, EventRow>;
}

export function entityKey(kind: KnowledgeOperationTarget['kind'], id: string): string {
  return `${kind}:${id}`;
}

/**
 * Scan every rate event carrying an own `knowledge_operation` key and strict-decode
 * each one BEFORE any id filtering. A malformed key cannot be attributed to a
 * target, so it throws instead of being skipped.
 */
export async function scanKnowledgeOperationRates(db: DbLike): Promise<KnowledgeOperationScan> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        sql`jsonb_exists(${event.payload}, ${KNOWLEDGE_OPERATION_KEY})`,
      ),
    );
  const byRateId = new Map<string, KnowledgeOperationEntry>();
  const targetsByEntity = new Map<string, string[]>();
  for (const row of rows) {
    const op = decodeKnowledgeOperation({
      eventId: row.id,
      subjectId: row.subject_id,
      causedByEventId: row.caused_by_event_id,
      payload: row.payload,
    });
    if (op === 'absent') continue;
    byRateId.set(row.id, { rate: row, op });
    for (const target of op.targets) {
      const key = entityKey(target.kind, target.id);
      const list = targetsByEntity.get(key);
      if (list) list.push(row.id);
      else targetsByEntity.set(key, [row.id]);
    }
  }
  return { byRateId, targetsByEntity };
}

// Every event id an operation pins: the decision's cause (proposal or archive
// fact), each target's fact, and — for archives — the retracted accept, its
// proposal, and the correction.
function referencedIds(entry: KnowledgeOperationEntry, facts: Map<string, EventRow>): string[] {
  const ids = new Set<string>();
  if (entry.rate.caused_by_event_id) ids.add(entry.rate.caused_by_event_id);
  for (const target of entry.op.targets) {
    if (target.fact_event_id) ids.add(target.fact_event_id);
  }
  if (entry.op.kind === 'archive') {
    ids.add(entry.op.retracts_accept_event_id);
    ids.add(entry.op.correction_event_id);
    const birthAccept = facts.get(entry.op.retracts_accept_event_id);
    if (birthAccept?.caused_by_event_id) ids.add(birthAccept.caused_by_event_id);
  }
  return [...ids];
}

async function loadFactRows(
  db: DbLike,
  ids: Iterable<string>,
  into: Map<string, EventRow>,
): Promise<void> {
  const missing = [...ids].filter((id) => !into.has(id));
  if (missing.length === 0) return;
  const rows = await db.select().from(event).where(inArray(event.id, missing));
  for (const row of rows) into.set(row.id, row);
}

// The knowledge ids a rate event minted: its own decoded v1 op when present,
// else the legacy materialized_ids.knowledge field.
function createdKnowledgeIdsOfRate(row: EventRow, scan: KnowledgeOperationScan): string[] {
  const op = scan.byRateId.get(row.id)?.op;
  if (op) {
    return op.targets
      .filter((t) => t.kind === 'knowledge' && t.effect === 'create')
      .map((t) => t.id);
  }
  const materialized = row.payload.materialized_ids;
  if (typeof materialized !== 'object' || materialized === null || Array.isArray(materialized)) {
    return [];
  }
  const ids = (materialized as Record<string, unknown>).knowledge;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

function fail(rateId: string, reason: 'missing_fact' | 'mismatched_fact', detail?: string): never {
  throw new UndecodableKnowledgeOperationError(rateId, reason, detail);
}

function factOrThrow(facts: Map<string, EventRow>, id: string, rateId: string): EventRow {
  const row = facts.get(id);
  if (!row) fail(rateId, 'missing_fact', `fact ${id}`);
  return row;
}

// Verify one decoded operation against the loaded fact envelopes. Every declared
// reference must resolve to a real event that matches what the target says it is;
// nothing is assumed from facts that were not loaded.
function verifyKnowledgeOperationReferences(
  entry: KnowledgeOperationEntry,
  scan: KnowledgeOperationScan,
  facts: Map<string, EventRow>,
): void {
  const { rate, op } = entry;
  const rateId = rate.id;

  if (op.kind === 'create') {
    const proposal = factOrThrow(facts, op.proposal_event_id, rateId);
    const isProposal =
      proposal.action === 'propose' || proposal.action.startsWith('experimental:knowledge_');
    if (
      !isProposal ||
      (proposal.subject_kind !== 'knowledge' && proposal.subject_kind !== 'knowledge_edge')
    ) {
      fail(rateId, 'mismatched_fact', 'proposal_event_id');
    }
    return;
  }

  for (const target of op.targets) {
    // Archive targets always carry fact_event_id (decode-enforced); '' never resolves.
    const fact = factOrThrow(facts, target.fact_event_id ?? '', rateId);
    if (target.kind === 'knowledge') {
      const payload = fact.payload;
      if (
        fact.action !== 'experimental:knowledge_archive' ||
        fact.subject_kind !== 'knowledge' ||
        fact.subject_id !== target.id ||
        payload.node_id !== target.id ||
        payload.expected_version !== target.before_version
      ) {
        fail(rateId, 'mismatched_fact', `fact ${target.fact_event_id}`);
      }
    } else {
      const payload = fact.payload;
      if (
        fact.action !== 'generate' ||
        fact.subject_kind !== 'knowledge_edge' ||
        fact.subject_id !== target.id ||
        payload.edge_op !== 'archive' ||
        payload.archive_edge_id !== target.id
      ) {
        fail(rateId, 'mismatched_fact', `fact ${target.fact_event_id}`);
      }
    }
  }

  const birthAccept = factOrThrow(facts, op.retracts_accept_event_id, rateId);
  if (birthAccept.action !== 'rate' || birthAccept.payload.rating !== 'accept') {
    fail(rateId, 'mismatched_fact', 'retracts_accept_event_id');
  }
  const minted = new Set(createdKnowledgeIdsOfRate(birthAccept, scan));
  for (const target of op.targets) {
    if (target.kind === 'knowledge' && !minted.has(target.id)) {
      fail(rateId, 'mismatched_fact', `retracts_accept_event_id does not mint ${target.id}`);
    }
  }
  const birthProposalId = birthAccept.caused_by_event_id;
  if (!birthProposalId || birthAccept.subject_id !== birthProposalId) {
    fail(rateId, 'mismatched_fact', 'retracts_accept_event_id cause');
  }
  const birthProposal = facts.get(birthProposalId);
  if (!birthProposal) fail(rateId, 'missing_fact', `proposal ${birthProposalId}`);
  if (birthProposal.subject_kind !== 'knowledge') {
    fail(rateId, 'mismatched_fact', 'birth proposal subject');
  }

  // The archive fact the RA accepted must be caused by the same proposal that
  // was retracted, and the correction must be the retract of that proposal.
  const archiveFact = factOrThrow(facts, rate.caused_by_event_id ?? '', rateId);
  if (archiveFact.caused_by_event_id !== birthProposalId) {
    fail(rateId, 'mismatched_fact', 'archive fact cause');
  }
  const correction = factOrThrow(facts, op.correction_event_id, rateId);
  if (
    correction.action !== 'correct' ||
    correction.subject_kind !== 'event' ||
    correction.subject_id !== birthProposalId ||
    correction.caused_by_event_id !== birthProposalId ||
    correction.payload.correction_kind !== 'retract'
  ) {
    fail(rateId, 'mismatched_fact', 'correction_event_id');
  }
}

async function prefetchFacts(
  db: DbLike,
  scan: KnowledgeOperationScan,
): Promise<Map<string, EventRow>> {
  const facts = new Map<string, EventRow>();
  for (const [rateId, entry] of scan.byRateId) facts.set(rateId, entry.rate);
  // Two rounds: the retracted accept's own proposal is only visible after the
  // first-level facts are loaded.
  for (let round = 0; round < 2; round += 1) {
    const ids = new Set<string>();
    for (const entry of scan.byRateId.values()) {
      for (const id of referencedIds(entry, facts)) ids.add(id);
    }
    await loadFactRows(db, ids, facts);
  }
  return facts;
}

/**
 * Scan + fact addressing for every knowledge operation in the log. Strict decode
 * happens inside the scan; fact rows are loaded for later verification but no
 * reference is checked here — callers verify the operations they consume.
 */
export async function prefetchKnowledgeOperations(db: DbLike): Promise<KnowledgeOperationContext> {
  const scan = await scanKnowledgeOperationRates(db);
  const facts = await prefetchFacts(db, scan);
  return { scan, facts };
}

/**
 * Verify the operations in `entries` against the loaded facts and return the
 * referenced event rows so the caller can merge them into its fold set.
 */
export function verifyKnowledgeOperationFacts(
  ctx: KnowledgeOperationContext,
  entries: readonly KnowledgeOperationEntry[],
): Map<string, EventRow> {
  const resolved = new Map<string, EventRow>();
  for (const entry of entries) {
    verifyKnowledgeOperationReferences(entry, ctx.scan, ctx.facts);
    for (const id of referencedIds(entry, ctx.facts)) {
      const row = ctx.facts.get(id);
      if (row) resolved.set(id, row);
    }
  }
  return resolved;
}

/**
 * Fail-closed pre-check for full-class writers (rebuild / canonical migration):
 * every knowledge operation in the log must decode AND verify before the first
 * entity write, so an undecodable fact aborts the surrounding transaction.
 */
export async function assertKnowledgeOperationsDecodable(db: DbLike): Promise<void> {
  const ctx = await prefetchKnowledgeOperations(db);
  verifyKnowledgeOperationFacts(ctx, [...ctx.scan.byRateId.values()]);
}
