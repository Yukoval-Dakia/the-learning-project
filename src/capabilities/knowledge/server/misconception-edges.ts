// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception_edge single-owner write throat.
//
// The HETEROGENEOUS-edge analog of edges.ts (knowledge_edge, ADR-0005/0010). ALL
// INSERTs / archives into `misconception_edge` go through this module; raw
// `db.insert(misconception_edge)` outside it is forbidden.
//
// RED LINES (mirror misconception-edge.ts / the schema):
//   - from_kind is ALWAYS 'misconception' (RT1 invariant) — pinned here.
//   - weight is CONFIDENCE-only salience (0-1, DB CHECK + Zod), NEVER mastery; this
//     edge feeds θ̂/p(L)/FSRS/difficulty/mastery NOTHING (ADR-0035 SOFT track).
//   - archived_at is the ONLY time dimension (soft-archive, no bi-temporal).
//
// IDENTITY = the DB unique index (from_kind, from_id, to_kind, to_id,
// relation_type), NOT a deterministic id. So a re-propose of the SAME edge UPSERTs
// (un-archives + refreshes weight) instead of throwing 23505. This is the
// deliberate divergence from createKnowledgeEdge (which 409s on dup): the promotion
// writer re-runs on re-induction of the same cause×KC, so a repeat caused_by edge
// MUST be idempotent (un-archive), not a hard conflict that strands the accept.
//
// Endpoints are loose text-refs (no enforced FK — polymorphic across
// misconception/knowledge/event per ADR-0036); existence is the caller's
// responsibility (the promotion writer passes a just-upserted misconception +
// a real knowledge_id). The topology gate validates endpoint KINDS, not existence.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';

import { newId } from '@/core/ids';
import type { AgentRef } from '@/core/schema/business';
import { MisconceptionEdgeInsert } from '@/core/schema/misconception-edge';
import type { Db, Tx } from '@/db/client';
import { misconception_edge } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import {
  type MisconceptionTopologyEdge,
  checkMisconceptionEdgeTopology,
} from './misconception-topology-gate';

type DbLike = Db | Tx;
type AgentRefT = z.infer<typeof AgentRef>;

// Every misconception edge originates at a misconception (RT1 invariant).
const FROM_KIND = 'misconception' as const;

export interface CreateMisconceptionEdgeInput {
  /** The source misconception id (from_kind is pinned to 'misconception'). */
  from_id: string;
  to_kind: 'misconception' | 'knowledge' | 'event';
  to_id: string;
  relation_type: string;
  /** CONFIDENCE-only edge salience, 0-1. Defaults to 1. */
  weight?: number;
  created_by: AgentRefT;
  proposed_by_ai?: boolean;
  /** Caller-supplied write instant (house convention — no defaultNow). */
  now?: Date;
}

/**
 * Insert (or upsert / un-archive) one misconception_edge through the single-owner
 * throat. Composes, in order:
 *   1. canonical ordering for SYMMETRIC misc↔misc confusable_with (smaller id is
 *      from_id) so A↔B and B↔A collapse to one unique-index row,
 *   2. Zod vocabulary + RT1 from_kind literal + weight-range + soft-track `.strict()`
 *      validation (MisconceptionEdgeInsert),
 *   3. the heterogeneous topology gate (checkMisconceptionEdgeTopology) against the
 *      LIVE neighbor edges (reject → ApiError 400; warn → proceed, DB unique idx owns dedup),
 *   4. an idempotent UPSERT keyed on the unique index (un-archive + refresh weight on
 *      re-propose, never a 23505).
 *
 * @returns the edge id — the EXISTING row's id on conflict-update, a fresh id on insert.
 */
export async function createMisconceptionEdge(
  db: DbLike,
  input: CreateMisconceptionEdgeInput,
): Promise<string> {
  const now = input.now ?? new Date();
  const proposedByAi = input.proposed_by_ai ?? false;
  const weight = input.weight ?? 1;

  // 1) Canonical ordering — confusable_with is SYMMETRIC. Only misc↔misc can be
  //    reordered (from_kind is pinned to 'misconception'); order so the smaller id
  //    is from_id, collapsing A↔B and B↔A onto one unique-index row.
  let fromId = input.from_id;
  let toId = input.to_id;
  if (
    input.relation_type === 'confusable_with' &&
    input.to_kind === 'misconception' &&
    toId < fromId
  ) {
    [fromId, toId] = [toId, fromId];
  }

  // 2) Validate vocabulary + RT1 from_kind literal + weight 0-1 + soft-track `.strict()`.
  //    Throws ZodError on a miss (the throat re-validates even though the promotion
  //    writer pre-shapes the input — defense in depth).
  const parsed = MisconceptionEdgeInsert.parse({
    id: newId(),
    from_kind: FROM_KIND,
    from_id: fromId,
    to_kind: input.to_kind,
    to_id: toId,
    relation_type: input.relation_type,
    weight,
    created_by: input.created_by,
    proposed_by_ai: proposedByAi,
    created_at: now,
    updated_at: now,
    archived_at: null,
  });

  // 3) Topology gate against the LIVE neighbor edges (archived_at IS NULL) touching
  //    either endpoint. reject → throw; warn → proceed (caller / unique idx own dedup).
  const neighbors = await db
    .select({
      from_kind: misconception_edge.from_kind,
      from_id: misconception_edge.from_id,
      to_kind: misconception_edge.to_kind,
      to_id: misconception_edge.to_id,
      relation_type: misconception_edge.relation_type,
    })
    .from(misconception_edge)
    .where(
      and(
        isNull(misconception_edge.archived_at),
        or(
          inArray(misconception_edge.from_id, [fromId, toId]),
          inArray(misconception_edge.to_id, [fromId, toId]),
        ),
      ),
    );
  const candidate: MisconceptionTopologyEdge = {
    from_kind: FROM_KIND,
    from_id: fromId,
    to_kind: input.to_kind,
    to_id: toId,
    relation_type: input.relation_type,
  };
  const verdict = checkMisconceptionEdgeTopology(candidate, neighbors);
  if (verdict.status === 'reject') {
    throw new ApiError(
      'validation_error',
      `misconception_edge topology reject [${verdict.gate}]: ${verdict.reason}`,
      400,
    );
  }

  // 4) Idempotent UPSERT — re-propose of the same (from,to,relation) un-archives +
  //    refreshes weight/updated_at instead of throwing 23505. `.returning` yields the
  //    surviving row id (the existing id on conflict-update, the fresh id on insert).
  const rows = await db
    .insert(misconception_edge)
    .values({
      id: parsed.id,
      from_kind: parsed.from_kind,
      from_id: parsed.from_id,
      to_kind: parsed.to_kind,
      to_id: parsed.to_id,
      relation_type: parsed.relation_type,
      weight: parsed.weight,
      created_by: parsed.created_by as AgentRefT,
      proposed_by_ai: parsed.proposed_by_ai,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      archived_at: null,
    })
    .onConflictDoUpdate({
      target: [
        misconception_edge.from_kind,
        misconception_edge.from_id,
        misconception_edge.to_kind,
        misconception_edge.to_id,
        misconception_edge.relation_type,
      ],
      set: {
        weight: parsed.weight,
        updated_at: now,
        archived_at: null,
      },
    })
    .returning({ id: misconception_edge.id });

  return rows[0].id;
}

export interface ArchiveMisconceptionEdgeResult {
  id: string;
  /** true if THIS call flipped archived_at NULL→now; false if already archived (idempotent no-op). */
  archived: boolean;
}

/**
 * Soft-delete one misconception_edge (set archived_at; never a hard DELETE — read
 * APIs filter `isNull(archived_at)`, so an archived edge leaves the live mesh but
 * the row survives for retract). Mirrors archiveKnowledgeEdge.
 *
 * Idempotent: the UPDATE is guarded on `isNull(archived_at)`, so re-archiving an
 * already-archived edge changes zero rows and returns `{ archived: false }`. This
 * is the SUPERSEDE removal the misconception reconcile ring performs (imperative,
 * no fold).
 *
 * @throws ApiError('not_found', 404) when no edge with `id` exists at all.
 */
export async function archiveMisconceptionEdge(
  db: DbLike,
  id: string,
  now: Date = new Date(),
): Promise<ArchiveMisconceptionEdgeResult> {
  const existing = await db
    .select({ id: misconception_edge.id, archived_at: misconception_edge.archived_at })
    .from(misconception_edge)
    .where(eq(misconception_edge.id, id))
    .limit(1);
  const row = existing[0];
  if (!row) {
    throw new ApiError('not_found', `misconception_edge not found: ${id}`, 404);
  }
  if (row.archived_at !== null) {
    return { id, archived: false };
  }

  await db
    .update(misconception_edge)
    .set({ archived_at: now, updated_at: now })
    .where(and(eq(misconception_edge.id, id), isNull(misconception_edge.archived_at)));

  return { id, archived: true };
}
