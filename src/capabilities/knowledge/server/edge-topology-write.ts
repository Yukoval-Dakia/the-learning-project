// YUK-737 — shared knowledge_edge accept-time write scaffold (lock discipline + ADR-0034 topology gate).
//
// PR #971 (YUK-546) gave decideKnowledgeEdgeProposal's create/reverse/change_type branch the full
// accept-time lock+gate discipline INLINE. YUK-737 extends the SAME discipline to the two remaining
// live-edge write paths that had none — the supersede accept branch and the direct POST
// /api/knowledge/edges route — so a `prerequisite` cycle can no longer be written through them.
// Rather than copy-paste the scaffold a third time, the reusable pieces live here and ALL THREE
// paths call them (the create branch was migrated to these helpers in the same change; its exact
// behaviour is pinned by edge-decide-advisory-lock.db.test.ts).
//
// The pieces (in the order the accept tx runs them):
//   - assertEdgeEndpointsValid   — both endpoints live + not a direct tree pair (moved here from
//                                  actions.ts so pre-tx fast-fail and in-tx revalidation share ONE
//                                  definition and can never drift).
//   - acquireEdgeEndpointLocks   — endpoint knowledge rows FOR UPDATE NOWAIT (id-sorted) + the
//                                  same-namespace sorted `knowledge_edge` advisory + a lock-scoped
//                                  endpoint revalidation (codex P2 lock-then-revalidate).
//   - runEdgeTopologyGate        — the flip-conditional fold gate (projectKnowledgeEdgeGuarded under
//                                  PROJECTION_IS_WRITER, else the read-only parity assert), which
//                                  re-runs ADR-0034 checkEdgeTopology through the fold and THROWS on
//                                  a cycle / direction reject (rolling the accept back). The optional
//                                  `translateReject` maps that throw to a clean ApiError for the
//                                  direct-call routes (see foldRejectToApiError).
//   - withEdgeEndpointLockRetry  — the bounded retry wrapper around the accept tx: a NOWAIT lock
//                                  miss (55P03) backs off + retries; a UNIQUE violation (23505)
//                                  surfaces as a 409; everything else (including a topology reject)
//                                  propagates.

import { eq, inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { ApiError } from '@/server/http/errors';
import { edgeRowToSnapshot } from '@/server/projections/gather';
import { projectKnowledgeEdgeGuarded } from '@/server/projections/knowledge_edge';
import { assertKnowledgeEdgeParity } from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { isDirectTreePair } from './topology-gate';

/**
 * YUK-546 — the edge-accept endpoint invariants (both endpoints live + not a direct tree pair),
 * factored out (OCR round-2) so the pre-tx fast-fail (on `db`) and the post-lock revalidation
 * (on `tx`, under the row + advisory locks) can never drift in what they enforce. Throws the same
 * ApiError shapes the inline checks used.
 *
 * YUK-737 — moved verbatim from actions.ts so the supersede branch and POST /edges reuse the SAME
 * definition rather than re-implementing the endpoint checks.
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
 * YUK-546 / YUK-737 — the in-tx lock preamble every live-edge accept shares, in the global lock
 * order (endpoint knowledge rows → knowledge_edge advisory), then a lock-scoped endpoint
 * revalidation.
 *
 *   1. FOR UPDATE NOWAIT (id-sorted) on the endpoint knowledge rows — mirrors lockMutationRows'
 *      strength + order so this path and the merge accept share ONE global order and cannot
 *      deadlock. NOWAIT (round-3): the accept fails fast (55P03) on any contended endpoint instead
 *      of blocking while holding a lock, so it is never the hold-and-wait edge of a merge-vs-accept
 *      cycle; the caller's bounded retry (withEdgeEndpointLockRetry) rolls back and retries.
 *   2. the same-namespace sorted `knowledge_edge` advisory (mirrors rewireKnowledgeEdges' merge-side
 *      lock) — acquired before the fold's live-mesh read so a concurrent accept of A→B and B→A
 *      serializes and the second is rejected by the ADR-0034 topology gate instead of silently
 *      completing the cycle.
 *   3. lock-then-revalidate (codex P2): re-assert both endpoint invariants under the locks — a
 *      merge holding the endpoint row + advisory can archive an endpoint + rewire + commit in the
 *      pre-lock window, after which a blind write would land a live edge pointing at the
 *      just-archived node.
 *
 * `endpointIds` is the de-duplicated endpoint set (locking/validating each id once); `fromId`/`toId`
 * feed the advisory + the tree-pair check (order-independent — both sort/dedup internally).
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
 * The fold's ADR-0034 topology reject throw shape, translated to a clean ApiError.
 *
 * foldKnowledgeEdge (src/core/projections/knowledge_edge.ts) throws a plain Error
 *   "foldKnowledgeEdge: ADR-0034 topology reject on edge <id> (gate=<gate>): <reason>"
 * on a cycle / direction_contradiction / tree_redundancy verdict. Under the OFF-path parity assert
 * that same message is re-wrapped as "... <fold-threw:topology>: foldKnowledgeEdge: ADR-0034 ...",
 * so matching the inner substring covers both flip states. Returns null for any other error (the
 * caller rethrows it unchanged).
 *
 * The 409 status matches the tree_redundancy / duplicate ApiErrors the write path already returns
 * for a conflict with the live topology; the gate name is preserved as the error CODE so a
 * direct caller (UI / tool) can distinguish cycle vs direction_contradiction.
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
 * YUK-737 — the flip-conditional accept-time fold gate, extracted verbatim from the create branch.
 *
 * PROJECTION_IS_WRITER ON (prod, LIVE): projectKnowledgeEdgeGuarded is the row writer AND re-runs the
 * ADR-0034 gate through the fold — a cycle/direction reject THROWS and rolls the accept back (the
 * real prod gate). OFF: the imperative INSERT already wrote the row; the read-only parity assert
 * re-folds and (dev/test) THROWS on the same reject, (prod) warns.
 *
 * `opts.translateReject` (the direct-call routes) maps the fold's plain-Error reject to a clean
 * ApiError; without it the raw Error propagates (the create branch's unchanged behaviour).
 */
export async function runEdgeTopologyGate(
  tx: Tx,
  edgeId: string,
  opts?: { translateReject?: boolean },
): Promise<void> {
  try {
    if (projectionIsWriter()) {
      await projectKnowledgeEdgeGuarded(tx, edgeId);
    } else {
      const writtenEdge = (
        await tx.select().from(knowledge_edge).where(eq(knowledge_edge.id, edgeId)).limit(1)
      )[0];
      await assertKnowledgeEdgeParity(
        tx,
        edgeId,
        writtenEdge ? edgeRowToSnapshot(writtenEdge) : null,
      );
    }
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
 * YUK-546 (codex P1, round-3) / YUK-737 — the bounded retry wrapper around the accept tx, extracted
 * from the create branch. The endpoint row lock inside is FOR UPDATE NOWAIT; on a contended endpoint
 * it fails fast (55P03) instead of blocking while holding another lock, so the accept can never be
 * the hold-and-wait edge of a merge-vs-accept cycle.
 *
 *   - 55P03 (lock_not_available): a concurrent structural writer holds a conflicting endpoint lock.
 *     Nothing committed; back off (exponential 25/50/…/500ms + jitter → ~0.6-1s window) and retry.
 *     Bounded so a genuinely stuck lock surfaces as a 409 rather than looping forever.
 *   - 23505 (unique_violation): the (from,to,relation_type) slot is taken → 409 with the caller's
 *     message. (createKnowledgeEdge already maps its own 23505, so this only fires for a raw INSERT.)
 *   - anything else (including a topology reject): propagate.
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
