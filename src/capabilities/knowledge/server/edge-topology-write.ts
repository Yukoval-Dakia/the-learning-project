// Shared scaffold for every live knowledge-edge write: validate endpoints, take the
// endpoint locks in global order, then run the topology gate in the same transaction.
//
// All paths use it so a prerequisite cycle cannot slip through a branch that copied only
// part of the discipline. NOWAIT lock misses retry with backoff; unique violations map
// to 409; topology rejects roll the write back.

import { inArray } from 'drizzle-orm';
import { isDirectTreePair } from '@/core/topology-gate';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { projectKnowledgeEdgeGuarded } from '@/server/projections/knowledge_edge';

/**
 * Endpoints must be live and must not repeat a direct tree pair. One definition serves
 * both the pre-transaction check and the locked revalidation.
 */
export async function assertEdgeEndpointsValid(
  dbOrTx: Db | Tx,
  fromId: string,
  toId: string,
  endpointIds: string[],
): Promise<void> {
  const rows = await dbOrTx
    .select({
      id: knowledge.id,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
    })
    .from(knowledge)
    .where(inArray(knowledge.id, endpointIds));
  const active = new Set(rows.filter((r) => r.archived_at === null).map((r) => r.id));
  const missing = endpointIds.filter((id) => !active.has(id));
  if (missing.length > 0) {
    throw new ApiError(
      'not_found',
      `unknown or archived knowledge_id(s): ${missing.join(', ')}`,
      404,
    );
  }
  if (
    isDirectTreePair(
      fromId,
      toId,
      rows.flatMap((node) =>
        node.parent_id ? [{ child_id: node.id, parent_id: node.parent_id }] : [],
      ),
    )
  ) {
    throw new ApiError(
      'tree_redundancy',
      `mesh edge repeats direct tree relationship: ${fromId} ↔ ${toId}`,
      409,
    );
  }
}

/**
 * Lock endpoints in the global order: endpoint rows for update, then the knowledge_edge
 * advisory, then revalidate. NOWAIT avoids hold-and-wait; the advisory serializes
 * concurrent A->B and B->A accepts so the gate sees the cycle. Revalidation catches an
 * endpoint archived by a merge between the pre-check and the lock.
 */
export async function acquireEdgeEndpointLocks(
  tx: Tx,
  fromId: string,
  toId: string,
  endpointIds: string[],
): Promise<void> {
  await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(inArray(knowledge.id, endpointIds))
    .orderBy(knowledge.id)
    .for('update', { noWait: true });
  await acquireSortedAdvisoryLocks(tx, 'knowledge_edge', [fromId, toId]);
  await assertEdgeEndpointsValid(tx, fromId, toId, endpointIds);
}

/**
 * Translate the fold's topology reject into a 409. Match the inner message, because the
 * parity assert may re-wrap it. Any other error returns null and is rethrown unchanged.
 */
function foldRejectToApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return null;
  const message = err instanceof Error ? err.message : String(err);
  const match = /ADR-0034 topology reject on edge \S+ \(gate=([a-z_]+)\): ([\s\S]*)/.exec(message);
  if (!match) return null;
  const gate = match[1];
  const reason = match[2].trim();
  return new ApiError(
    gate,
    `knowledge_edge write rejected by ADR-0034 topology gate (${gate}): ${reason}`,
    409,
  );
}

/**
 * Materialize the accepted event and enforce topology in the same transaction. A reject
 * always aborts; `translateReject` maps it to a clean ApiError for direct routes.
 */
export async function runEdgeTopologyGate(
  tx: Tx,
  edgeId: string,
  opts?: { translateReject?: boolean },
): Promise<void> {
  try {
    await projectKnowledgeEdgeGuarded(tx, edgeId);
  } catch (err) {
    if (opts?.translateReject) {
      const apiErr = foldRejectToApiError(err);
      if (apiErr) throw apiErr;
    }
    throw err;
  }
}

const MAX_LOCK_ATTEMPTS = 6;

/**
 * Retry a contended NOWAIT lock with bounded backoff, so a stuck lock ends as 409 rather
 * than looping. A unique violation maps to 409; topology rejects propagate.
 */
export async function withEdgeEndpointLockRetry<T>(
  runTx: () => Promise<T>,
  opts: { uniqueViolationMessage: string },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runTx();
    } catch (err) {
      const pgCode =
        (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (pgCode === '55P03') {
        if (attempt >= MAX_LOCK_ATTEMPTS) {
          throw new ApiError(
            'conflict',
            `edge accept could not acquire endpoint locks after ${MAX_LOCK_ATTEMPTS} attempts (a concurrent structural change holds them)`,
            409,
          );
        }
        const backoffMs = Math.min(25 * 2 ** (attempt - 1), 500);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.floor(backoffMs * (0.75 + Math.random() * 0.5))),
        );
        continue;
      }
      if (pgCode === '23505') {
        throw new ApiError('conflict', opts.uniqueViolationMessage, 409);
      }
      throw err;
    }
  }
}
