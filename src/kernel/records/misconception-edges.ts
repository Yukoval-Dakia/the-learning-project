// Single write throat for misconception_edge. All inserts and archives go through
// here; raw inserts elsewhere are forbidden.
//
// from_kind is always 'misconception'. Weight is confidence salience, never mastery,
// and this edge feeds no learning model. archived_at is the only time dimension.
//
// Identity is the DB unique index, not an id, so re-proposing the same edge upserts
// and refreshes weight instead of failing. That matters because promotion reruns on
// re-induction of the same cause. An upsert never un-archives unless the caller
// explicitly reactivates, so a retired edge is not silently resurrected.
//
// Endpoints are loose text refs (polymorphic, no FK); the gate checks their kinds,
// not their existence.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';

import { newId } from '@/core/ids';
import { AgentRef } from '@/core/schema/business';
import { MisconceptionEdgeInsert } from '@/core/schema/misconception-edge';
import type { Db, Tx } from '@/db/client';
import { misconception_edge } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  type MisconceptionTopologyEdge,
  checkMisconceptionEdgeTopology,
} from './misconception-topology-gate';

type DbLike = Db | Tx;
type AgentRefT = z.infer<typeof AgentRef>;

// Every misconception edge originates at a misconception (RT1 invariant).
const FROM_KIND = 'misconception' as const;

export interface CreateMisconceptionEdgeInput {
  from_id: string;
  to_kind: 'misconception' | 'knowledge' | 'event';
  to_id: string;
  relation_type: string;
  /** Confidence salience, 0-1. */
  weight?: number;
  created_by: AgentRefT;
  proposed_by_ai?: boolean;
  now?: Date;
  /** Only true clears the archive tombstone on an upsert. */
  reactivate?: boolean;
}

/**
 * Insert or upsert one edge: canonicalize symmetric ids, validate, run the live
 * topology gate, then upsert. Returns the existing row id on conflict.
 */
export async function createMisconceptionEdge(
  db: DbLike,
  input: CreateMisconceptionEdgeInput,
): Promise<string> {
  const now = input.now ?? new Date();
  const proposedByAi = input.proposed_by_ai ?? false;
  const weight = input.weight ?? 1;

  // confusable_with is symmetric, so order ids to collapse A<->B onto one row.
  let fromId = input.from_id;
  let toId = input.to_id;
  if (
    input.relation_type === 'confusable_with' &&
    input.to_kind === 'misconception' &&
    toId < fromId
  ) {
    [fromId, toId] = [toId, fromId];
  }

  // Revalidate even though callers pre-shape input; defense in depth.
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

  // Gate against live neighbors: reject throws, warn proceeds.
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

  // Upsert refreshes weight; archive state changes only on explicit reactivation.
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
        ...(input.reactivate ? { archived_at: null } : {}),
      },
    })
    .returning({ id: misconception_edge.id });

  return rows[0].id;
}

export interface ArchiveMisconceptionEdgeResult {
  id: string;
  /** False when the edge was already archived. */
  archived: boolean;
}

/**
 * Soft-delete by setting archived_at; rows survive for retract. Idempotent, and used
 * by the reconcile ring's supersede removal. Missing ids are 404.
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

/** Repoint live edges during a KC merge; owns collision and reactivation semantics. */
export async function rewireMisconceptionEdgesForKnowledgeMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .select({
      id: misconception_edge.id,
      from_id: misconception_edge.from_id,
      relation_type: misconception_edge.relation_type,
      weight: misconception_edge.weight,
      created_by: misconception_edge.created_by,
      proposed_by_ai: misconception_edge.proposed_by_ai,
    })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.to_kind, 'knowledge'),
        eq(misconception_edge.to_id, fromId),
        isNull(misconception_edge.archived_at),
      ),
    );
  const handled: string[] = [];
  for (const row of rows) {
    await archiveMisconceptionEdge(tx, row.id, now);
    await createMisconceptionEdge(tx, {
      from_id: row.from_id,
      to_kind: 'knowledge',
      to_id: intoId,
      relation_type: row.relation_type,
      weight: row.weight,
      created_by: AgentRef.parse(row.created_by),
      proposed_by_ai: row.proposed_by_ai,
      now,
      reactivate: true,
    });
    handled.push(row.id);
  }
  return handled;
}
