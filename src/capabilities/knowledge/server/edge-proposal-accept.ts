import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { getProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
import { findExistingRateEvent } from '@/server/proposals/applier-helpers';
import {
  acquireEdgeEndpointLocks,
  assertEdgeEndpointsValid,
  runEdgeTopologyGate,
  withEdgeEndpointLockRetry,
} from './edge-topology-write';
import { archiveKnowledgeEdgeFromEvents } from './edges';
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
    // Legacy events predate this field and default to create.
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

  // A rubric-folded event has no rate row, so the idempotency guard above misses it.
  // Reject any non-pending status before writing, or the rubric could be bypassed.
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

  // Archive accepts soft-delete the named edge; never hard delete, so correction
  // stays possible. reverse/change_type only make sense for creates.
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
    await db.transaction(async (tx) => {
      const now = new Date();
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

      const archived = await archiveKnowledgeEdgeFromEvents(tx, archiveEdgeId, {
        event_id: generateEventId,
        caused_by_event_id: proposeEventId,
        propose_event_id: proposeEventId,
        reasoning: proposePayload.reasoning ?? null,
      });
      if (!archived.archived) {
        throw new ApiError('conflict', `knowledge_edge ${archiveEdgeId} is already archived`, 409);
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

  // The judge's supersede stays a proposal until this accept; the replacement,
  // archive, provenance and audit apply atomically here.
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

    // Supersede creates a live replacement, so it needs the same locks and topology
    // gate as create; without them a replacement could close a prerequisite cycle.
    const newFromId = proposePayload.from_knowledge_id;
    const newToId = proposePayload.to_knowledge_id;
    const supersedeEndpointIds = Array.from(new Set([newFromId, newToId]));

    const applied = await withEdgeEndpointLockRetry(
      () =>
        db.transaction(async (tx) => {
          await acquireEdgeEndpointLocks(tx, newFromId, newToId, supersedeEndpointIds);

          // NOWAIT: blocking here while holding endpoint locks could deadlock with a merge.
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

          // Gate after archiving, against the post-supersede mesh. A reject rolls all back.
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
  // Fast-fail before opening a transaction; the locks re-assert the same invariants.
  await assertEdgeEndpointsValid(db, fromId, toId, endpointIds);

  const edgeId = createId();
  const generateEventId = createId();
  // Lock endpoints, write rate and generate events, then gate topology. The wrapper
  // retries NOWAIT contention and maps unique violations to 409.
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
            // Null, not '', so the event folds losslessly into the row.
            reasoning: proposePayload.reasoning ?? null,
            propose_event_id: proposeEventId,
          },
          caused_by_event_id: proposeEventId,
          created_at: now,
        });

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
