import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import type { ProposalAcceptApplier } from '@/kernel/proposals';
import { projectKnowledgeEdgeGuarded } from '@/server/projections/knowledge_edge';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { findExistingRateEvent } from '@/server/proposals/applier-helpers';
import { getProposalInboxRow } from '@/server/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/server/proposals/signals';
import {
  acquireEdgeEndpointLocks,
  assertEdgeEndpointsValid,
  runEdgeTopologyGate,
  withEdgeEndpointLockRetry,
} from './edge-topology-write';
import { archiveKnowledgeEdge } from './edges';
import { applyApprovedEdgeSupersede } from './propose_edge';

const SUPERSEDE_DEFAULT_REASON = 'accepted reconcile supersede';

export type EdgeProposalDecision = 'accept' | 'reverse' | 'change_type' | 'dismiss';

export interface EdgeProposalDecisionInput {
  decision: EdgeProposalDecision;
  new_relation_type?: RelationTypeSchemaT;
  user_note?: string;
}

export interface KnowledgeEdgeProposalDecisionResult {
  kind: 'knowledge_edge';
  rate_event_id: string;
  generate_event_id: string | null;
  edge_id: string | null;
  idempotent?: boolean;
}

function assertEdgeDecisionInput(input: EdgeProposalDecisionInput): void {
  if (input.decision === 'change_type' && !input.new_relation_type) {
    throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
  }
}

export async function decideKnowledgeEdgeProposal(
  db: Db,
  proposeEventId: string,
  input: EdgeProposalDecisionInput,
): Promise<KnowledgeEdgeProposalDecisionResult> {
  assertEdgeDecisionInput(input);
  const { decision, new_relation_type, user_note } = input;

  const proposeRows = await db.select().from(event).where(eq(event.id, proposeEventId)).limit(1);
  const proposeRow = proposeRows[0];
  if (!proposeRow) {
    throw new ApiError('not_found', `propose event ${proposeEventId} not found`, 404);
  }
  if (proposeRow.action !== 'propose' || proposeRow.subject_kind !== 'knowledge_edge') {
    throw new ApiError(
      'validation_error',
      `event ${proposeEventId} is not a knowledge_edge proposal (action=${proposeRow.action}, subject_kind=${proposeRow.subject_kind})`,
      400,
    );
  }
  const proposal = await getProposalInboxRow(db, proposeEventId);
  const proposePayload = proposeRow.payload as {
    // ADR-0032 D4-E1 (YUK-203) — edge_op discriminator on the raw event payload
    // (writer.ts stamps it; legacy events written before this field are absent →
    // treated as 'create' below, the backward-compatible default).
    edge_op?: 'create' | 'archive' | 'supersede';
    archive_edge_id?: string;
    supersede_confidence?: number;
    supersede_neighbor_index?: number | null;
    supersede_affected_refs?: ActivityRefT[];
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: string;
    weight?: number;
    reasoning?: string;
  };
  const edgeOp = proposePayload.edge_op ?? 'create';
  const proposeSubjectId = proposeRow.subject_id;

  const existingRate = await findExistingRateEvent(db, proposeEventId);
  if (existingRate) {
    if (existingRate.decision !== decision) {
      throw new ApiError(
        'conflict',
        `proposal ${proposeEventId} already decided as ${existingRate.decision}`,
        409,
      );
    }
    if (proposal) {
      await ensureProposalDecisionSignal(
        db,
        proposal,
        decision === 'dismiss' ? 'dismiss' : 'accept',
        user_note,
      );
    }
    const existingGenRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'generate'),
          eq(event.subject_kind, 'knowledge_edge'),
          eq(event.caused_by_event_id, proposeEventId),
          ...(edgeOp === 'supersede'
            ? [sql`(${event.payload}->>'edge_op') IS DISTINCT FROM 'archive'`]
            : []),
        ),
      )
      .limit(1);
    const gen = existingGenRows[0];
    return {
      kind: 'knowledge_edge',
      rate_event_id: existingRate.id,
      generate_event_id: gen?.id ?? null,
      edge_id: gen?.subject_id ?? null,
      idempotent: true,
    };
  }

  // P5.4 / YUK-143 (RB-8) — the folded `rubric_rejected` bucket must be truly
  // NON-EXECUTABLE. A rubric-rejected propose event carries no chained rate, so
  // it slips past the `existingRate` idempotency guard above; without this check
  // any caller with the propose event id could accept / reverse / change_type it
  // and write the knowledge_edge anyway, bypassing the Layer-1 rubric. Reject any
  // decision whose derived status is not `pending` (rubric_rejected, or any other
  // terminal status: accepted/dismissed/stale that reached here without a matching
  // rate row) BEFORE writing any rate or edge. A genuinely accepted/dismissed
  // proposal re-decided with the SAME decision is handled idempotently above; a
  // genuinely pending proposal is unaffected.
  if (proposal && proposal.status !== 'pending') {
    throw new ApiError(
      'not_pending',
      `proposal ${proposeEventId} is not pending (status=${proposal.status}); rubric-folded and terminal proposals are not executable`,
      409,
    );
  }

  const now = new Date();
  const rateEventId = createId();

  if (decision === 'dismiss') {
    await writeEvent(db, {
      id: rateEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: proposeSubjectId,
      outcome: 'success',
      payload: {
        rating: 'dismiss',
        ...(user_note ? { user_note } : {}),
      },
      caused_by_event_id: proposeEventId,
      created_at: now,
    });
    if (proposal) {
      await recordProposalDecisionSignal(db, proposal, 'dismiss', user_note);
    }
    return {
      kind: 'knowledge_edge',
      rate_event_id: rateEventId,
      generate_event_id: null,
      edge_id: null,
    };
  }

  // ADR-0032 D4-E1 (YUK-203) — ARCHIVE accept. Soft-deletes the live edge named by
  // archive_edge_id (set archived_at via the single-owner edges module; never a
  // hard delete — 守 propose+correction-reversible 不变量). reverse / change_type
  // are CREATE-edge semantics and meaningless for an archive proposal; reject them.
  // Idempotency mirrors create: the existingRate guard above short-circuits a
  // re-accept, and archiveKnowledgeEdge itself is a NULL→now guarded no-op, so a
  // racing/duplicate accept that slips past the guard still cannot double-archive.
  if (edgeOp === 'archive') {
    if (decision !== 'accept') {
      throw new ApiError(
        'validation_error',
        `knowledge_edge archive proposal only supports accept/dismiss, got ${decision}`,
        400,
      );
    }
    const archiveEdgeId = proposePayload.archive_edge_id;
    if (!archiveEdgeId) {
      throw new ApiError(
        'validation_error',
        `edge archive proposal ${proposeEventId} missing archive_edge_id`,
        400,
      );
    }

    const generateEventId = createId();
    // YUK-471 W1 PR-B — SoT flip gate (archive branch). ON: keep the imperative archive UPDATE
    // (the soft-delete mutation) AND project the edge from its events so the row reflects
    // archived_at.
    const flip = projectionIsWriter();
    await db.transaction(async (tx) => {
      await writeEvent(tx, {
        id: rateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'knowledge_edge',
        subject_id: proposeSubjectId,
        outcome: 'success',
        payload: {
          rating: 'accept',
          edge_op: 'archive',
          ...(user_note ? { user_note } : {}),
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });

      // Single-owner soft-delete. A racing archive that won after the preflight guard is a
      // conflict: roll this transaction back rather than appending a second fold-visible archive
      // event whose timestamp would diverge from the row.
      const archived = await archiveKnowledgeEdge(tx, archiveEdgeId, now);
      if (!archived.archived) {
        throw new ApiError(
          'conflict',
          `knowledge_edge ${archiveEdgeId} changed before proposal ${proposeEventId} was applied`,
          409,
        );
      }

      // Provenance + idempotency anchor: a `generate` event whose subject is the
      // archived edge, mirroring the create path so the re-decide guard above
      // returns a consistent { generate_event_id, edge_id }.
      await writeEvent(tx, {
        id: generateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'generate',
        subject_kind: 'knowledge_edge',
        subject_id: archiveEdgeId,
        outcome: 'success',
        payload: {
          edge_op: 'archive',
          archive_edge_id: archiveEdgeId,
          from_knowledge_id: proposePayload.from_knowledge_id,
          to_knowledge_id: proposePayload.to_knowledge_id,
          relation_type: proposePayload.relation_type,
          // YUK-471 W1 PR-A2b — encode absent reasoning as null (not ''), matching the
          // ROW's `?? null` so the edge fold is lossless (see GenerateKnowledgeEdge note).
          reasoning: proposePayload.reasoning ?? null,
          propose_event_id: proposeEventId,
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });

      // YUK-471 W1 PR-B — flip ON: project the archived edge from its events (its create
      // generate + this archive generate) so the projection reflects archived_at; the
      // imperative archiveKnowledgeEdge UPDATE above stays (the soft-delete mutation). Guarded.
      if (flip) {
        await projectKnowledgeEdgeGuarded(tx, archiveEdgeId);
      }
    });

    if (proposal) {
      await recordProposalDecisionSignal(db, proposal, 'accept', user_note);
    }

    return {
      kind: 'knowledge_edge',
      rate_event_id: rateEventId,
      generate_event_id: generateEventId,
      edge_id: archiveEdgeId,
    };
  }

  // YUK-689 — SUPERSEDE is proposal-only until this explicit accept. The model's
  // reconcile decision is carried on the proposal, while the replacement create,
  // old-edge archive, correction provenance and audit log apply atomically here.
  if (edgeOp === 'supersede') {
    if (decision !== 'accept') {
      throw new ApiError(
        'validation_error',
        `knowledge_edge supersede proposal only supports accept/dismiss, got ${decision}`,
        400,
      );
    }
    const supersededEdgeId = proposePayload.archive_edge_id;
    const confidence = proposePayload.supersede_confidence;
    const affectedRefs = proposePayload.supersede_affected_refs;
    if (!supersededEdgeId || confidence === undefined || !affectedRefs?.length) {
      throw new ApiError(
        'validation_error',
        `edge supersede proposal ${proposeEventId} is missing its judged decision metadata`,
        400,
      );
    }

    // YUK-737 — the supersede accept CREATES a live edge (the replacement candidate) just like
    // create/reverse/change_type, so it gets the SAME accept-time discipline: endpoint locks +
    // sorted advisory + lock-scoped revalidation (acquireEdgeEndpointLocks on the NEW edge's
    // endpoints), the whole accept tx wrapped in the bounded NOWAIT retry, and the ADR-0034 fold
    // topology gate on the replacement (runEdgeTopologyGate). Before #971/#YUK-737 the supersede
    // branch had NO accept-time cycle check — the reconcile replacement could close a prerequisite
    // cycle. translateReject surfaces a clean Api(409) since this decision is reachable via the
    // proposal-decide route.
    const newFromId = proposePayload.from_knowledge_id;
    const newToId = proposePayload.to_knowledge_id;
    const supersedeEndpointIds = Array.from(new Set([newFromId, newToId]));

    const applied = await withEdgeEndpointLockRetry(
      () =>
        db.transaction(async (tx) => {
          await acquireEdgeEndpointLocks(tx, newFromId, newToId, supersedeEndpointIds);

          // YUK-737 — lock the OLD edge row NOWAIT (was a blocking FOR UPDATE): once the endpoint
          // locks above are held, blocking here could form a merge-vs-supersede deadlock, so fail
          // fast (55P03) and let withEdgeEndpointLockRetry roll back + retry, per the NOWAIT doctrine.
          const oldEdge = (
            await tx
              .select()
              .from(knowledge_edge)
              .where(eq(knowledge_edge.id, supersededEdgeId))
              .limit(1)
              .for('update', { noWait: true })
          )[0];
          if (!oldEdge || oldEdge.archived_at !== null) {
            throw new ApiError(
              'conflict',
              `superseded knowledge_edge is no longer live: ${supersededEdgeId}`,
              409,
            );
          }
          const candidateTouchesOld =
            oldEdge.from_knowledge_id === proposePayload.from_knowledge_id ||
            oldEdge.to_knowledge_id === proposePayload.from_knowledge_id ||
            oldEdge.from_knowledge_id === proposePayload.to_knowledge_id ||
            oldEdge.to_knowledge_id === proposePayload.to_knowledge_id;
          const candidateIsDuplicate =
            oldEdge.from_knowledge_id === proposePayload.from_knowledge_id &&
            oldEdge.to_knowledge_id === proposePayload.to_knowledge_id &&
            oldEdge.relation_type === proposePayload.relation_type;
          if (!candidateTouchesOld || candidateIsDuplicate) {
            throw new ApiError(
              'validation_error',
              candidateIsDuplicate
                ? `supersede candidate duplicates target edge ${supersededEdgeId}`
                : `supersede candidate does not touch target edge ${supersededEdgeId}`,
              400,
            );
          }

          await writeEvent(tx, {
            id: rateEventId,
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'rate',
            subject_kind: 'knowledge_edge',
            subject_id: proposeSubjectId,
            outcome: 'success',
            payload: {
              rating: 'accept',
              edge_op: 'supersede',
              ...(user_note ? { user_note } : {}),
            },
            caused_by_event_id: proposeEventId,
            created_at: now,
          });

          const result = await applyApprovedEdgeSupersede(tx, {
            candidate: {
              from_knowledge_id: proposePayload.from_knowledge_id,
              to_knowledge_id: proposePayload.to_knowledge_id,
              relation_type: proposePayload.relation_type,
              weight: proposePayload.weight ?? 0.5,
              reasoning: proposePayload.reasoning ?? SUPERSEDE_DEFAULT_REASON,
            },
            supersededEdgeId,
            supersededEdge: {
              from_knowledge_id: oldEdge.from_knowledge_id,
              to_knowledge_id: oldEdge.to_knowledge_id,
              relation_type: oldEdge.relation_type,
            },
            decision: {
              action: 'SUPERSEDE',
              neighbor_index: proposePayload.supersede_neighbor_index ?? null,
              superseded_edge_id: supersededEdgeId,
              confidence,
              reason: proposePayload.reasoning ?? SUPERSEDE_DEFAULT_REASON,
            },
            affectedRefs,
            proposeEventId,
          });

          // ADR-0034 topology gate on the replacement edge (runs AFTER the old edge is archived, so
          // the live mesh reflects the post-supersede state). A cycle / direction reject THROWS and
          // rolls the whole supersede back — nothing lands.
          await runEdgeTopologyGate(tx, result.edgeId, { translateReject: true });

          return result;
        }),
      {
        uniqueViolationMessage: `edge already exists: ${newFromId} --${proposePayload.relation_type}--> ${newToId}`,
      },
    );

    if (proposal) {
      await recordProposalDecisionSignal(db, proposal, 'accept', user_note);
    }
    return {
      kind: 'knowledge_edge',
      rate_event_id: rateEventId,
      generate_event_id: applied.generateEventId,
      edge_id: applied.edgeId,
    };
  }

  const fromId =
    decision === 'reverse' ? proposePayload.to_knowledge_id : proposePayload.from_knowledge_id;
  const toId =
    decision === 'reverse' ? proposePayload.from_knowledge_id : proposePayload.to_knowledge_id;
  const relationType =
    decision === 'change_type' ? (new_relation_type as string) : proposePayload.relation_type;
  const weight = proposePayload.weight ?? 1;

  const endpointIds = Array.from(new Set([fromId, toId]));
  // Pre-tx fast-fail (no lock): reject an obviously-invalid proposal before opening a tx. The
  // authoritative re-check runs under the locks inside the tx (acquireEdgeEndpointLocks re-asserts
  // the same invariant tx-scoped).
  await assertEdgeEndpointsValid(db, fromId, toId, endpointIds);

  const edgeId = createId();
  const generateEventId = createId();
  // YUK-471 W1 PR-B — SoT flip gate. ON: skip the imperative edge INSERT; runEdgeTopologyGate
  // (projectKnowledgeEdgeGuarded) writes the edge row from the generate event below.
  const flip = projectionIsWriter();

  // YUK-546 (codex P1) / YUK-737 — the accept tx runs inside the shared bounded-retry wrapper. Inside:
  //   1. acquireEdgeEndpointLocks — endpoint rows FOR UPDATE NOWAIT (id-sorted) + the sorted
  //      knowledge_edge advisory + a lock-scoped endpoint revalidation, so this path and the merge
  //      accept share ONE global lock order and a merge that archives an endpoint under the locks is
  //      caught (codex P2) rather than landing a live edge on a tombstone.
  //   2. the rate + generate writes (+ the flip-OFF imperative INSERT).
  //   3. runEdgeTopologyGate — the flip-conditional fold gate that re-runs ADR-0034 topology and
  //      THROWS (rolls the accept back) on a cycle / direction reject.
  // The wrapper backs off + retries a NOWAIT lock miss (55P03) and maps a UNIQUE violation (23505,
  // from the flip-OFF raw INSERT or the flip-ON projection upsert) to a 409.
  await withEdgeEndpointLockRetry(
    () =>
      db.transaction(async (tx) => {
        await acquireEdgeEndpointLocks(tx, fromId, toId, endpointIds);

        await writeEvent(tx, {
          id: rateEventId,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'rate',
          subject_kind: 'knowledge_edge',
          subject_id: proposeSubjectId,
          outcome: 'success',
          payload: {
            rating: decision,
            ...(decision === 'reverse' ? { new_direction_reversed: true } : {}),
            ...(decision === 'change_type' ? { new_relation_type: relationType } : {}),
            ...(user_note ? { user_note } : {}),
          },
          caused_by_event_id: proposeEventId,
          created_at: now,
        });

        // YUK-471 W1 PR-B — under the flip the imperative INSERT is skipped; runEdgeTopologyGate
        // (projectKnowledgeEdgeGuarded) writes the edge row from the generate event.
        if (!flip) {
          await tx.insert(knowledge_edge).values({
            id: edgeId,
            from_knowledge_id: fromId,
            to_knowledge_id: toId,
            relation_type: relationType,
            weight,
            created_by: {
              actor_kind: 'user',
              actor_ref: 'self',
              propose_event_id: proposeEventId,
            } as never,
            reasoning: proposePayload.reasoning ?? null,
            created_at: now,
          });
        }

        await writeEvent(tx, {
          id: generateEventId,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'generate',
          subject_kind: 'knowledge_edge',
          subject_id: edgeId,
          outcome: 'success',
          payload: {
            from_knowledge_id: fromId,
            to_knowledge_id: toId,
            relation_type: relationType,
            weight,
            // YUK-471 W1 PR-A2b — encode absent reasoning as null (not ''), matching the
            // ROW's `?? null` above so the edge fold is lossless (see GenerateKnowledgeEdge
            // note). The generate-event payload now equals the row byte-for-byte.
            reasoning: proposePayload.reasoning ?? null,
            propose_event_id: proposeEventId,
          },
          caused_by_event_id: proposeEventId,
          created_at: now,
        });

        // Flip ON: projectKnowledgeEdgeGuarded writes the edge row from the generate event + re-runs
        // ADR-0034 topology (a cycle reject THROWS and rolls back). Flip OFF: the read-only parity
        // assert re-folds the just-written edge (same reject propagates in dev/test). This branch's
        // raw plain-Error reject propagates unchanged (no translateReject) — the accept-path contract
        // #971 pinned.
        await runEdgeTopologyGate(tx, edgeId);
      }),
    { uniqueViolationMessage: `edge already exists: ${fromId} --${relationType}--> ${toId}` },
  );

  if (proposal) {
    await recordProposalDecisionSignal(db, proposal, 'accept', user_note);
  }

  return {
    kind: 'knowledge_edge',
    rate_event_id: rateEventId,
    generate_event_id: generateEventId,
    edge_id: edgeId,
  };
}

export const knowledgeEdgeProposalAcceptApplier: ProposalAcceptApplier = async (db, input) => {
  const result = await decideKnowledgeEdgeProposal(db as Db, input.proposalId, {
    decision: input.decision ?? 'accept',
    new_relation_type: input.new_relation_type,
    user_note: input.user_note,
  });
  return {
    kind: 'knowledge_edge',
    result,
    lifecycle_outcome: result.generate_event_id === null ? 'dismissed' : 'accepted',
  };
};
