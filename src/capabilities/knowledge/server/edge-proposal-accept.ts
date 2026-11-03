import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { ActivityRefT } from '@/core/schema/activity';
import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  type ProposalAcceptEffectOutcome,
  runProposalAccept,
  runProposalDismiss,
} from '@/kernel/proposals/decision-protocol';
import { type ProposalInboxRow, getProposalInboxRow } from '@/kernel/proposals/inbox';
import type { ProposalSignalSource } from '@/kernel/proposals/signals';
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
  /** Null only for an idempotent no-write replay (e.g. a corrected proposal's dismiss). */
  rate_event_id: string | null;
  generate_event_id: string | null;
  edge_id: string | null;
  idempotent?: boolean;
}

type EdgeProposePayload = {
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

type EdgeAcceptPrepared =
  | { readonly op: 'archive'; readonly archiveEdgeId: string }
  | {
      readonly op: 'supersede';
      readonly supersededEdgeId: string;
      readonly confidence: number;
      readonly affectedRefs: ActivityRefT[];
      readonly newFromId: string;
      readonly newToId: string;
      readonly endpointIds: string[];
    }
  | {
      readonly op: 'create';
      readonly fromId: string;
      readonly toId: string;
      readonly relationType: string;
      readonly weight: number;
      readonly endpointIds: string[];
    };

function assertEdgeDecisionInput(input: EdgeProposalDecisionInput): void {
  if (input.decision === 'change_type' && !input.new_relation_type) {
    throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
  }
}

function assertStillPending(proposal: ProposalInboxRow, proposeEventId: string): void {
  if (proposal.status !== 'pending') {
    throw new ApiError(
      'not_pending',
      `proposal ${proposeEventId} is not pending (status=${proposal.status}); rubric-folded and terminal proposals are not executable`,
      409,
    );
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
  const signalSource: ProposalSignalSource = proposal ?? {
    id: proposeEventId,
    kind: 'knowledge_edge',
    payload: {},
  };
  const proposePayload = proposeRow.payload as EdgeProposePayload;
  const proposeSubjectId = proposeRow.subject_id;
  const edgeOp = proposePayload.edge_op ?? 'create';
  // Edge decisions keep the RateKnowledgeEdge shape: subject_kind='knowledge_edge'
  // (the wider-rating schema) anchored on the propose event's synthetic subject.
  const rateSubject = { kind: 'knowledge_edge', id: proposeSubjectId } as const;

  const replayResult = async (rate: {
    id: string;
    payload: unknown;
  }): Promise<KnowledgeEdgeProposalDecisionResult> => {
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
      rate_event_id: rate.id,
      generate_event_id: gen?.id ?? null,
      edge_id: gen?.subject_id ?? null,
      idempotent: true,
    };
  };

  if (decision === 'dismiss') {
    const dismissed = await runProposalDismiss(db, proposeEventId, {
      proposal: signalSource,
      userNote: user_note,
      signal: 'after_commit',
      rateSubject,
      effect: async () => {
        // A rubric-folded event has no rate row, so the decision re-check misses it.
        // Reject any non-pending status before the rate commits, or the rubric could
        // be bypassed. The throw rolls the fresh dismiss rate back with it.
        if (proposal) assertStillPending(proposal, proposeEventId);
      },
    });
    return {
      kind: 'knowledge_edge',
      rate_event_id: dismissed.rate_event_id,
      generate_event_id: null,
      edge_id: null,
      ...(dismissed.idempotent ? { idempotent: true } : {}),
    };
  }

  const run = await (async () => {
    const accept = () =>
      runProposalAccept(db, proposeEventId, {
        proposal: signalSource,
        userNote: user_note,
        signal: 'after_commit',
        rating: decision,
        replay: replayResult,
        prepare: async (): Promise<EdgeAcceptPrepared> => {
          // Rubric-folded and terminal proposals are not executable — same gate the
          // pre-template writer checked after its rate lookup.
          if (proposal) assertStillPending(proposal, proposeEventId);

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
            return { op: 'archive', archiveEdgeId };
          }

          // The judge's supersede stays a proposal until this accept; the replacement,
          // archive, provenance and audit apply atomically in the effect.
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
            // Supersede creates a live replacement, so it needs the same locks and
            // topology gate as create; without them a replacement could close a
            // prerequisite cycle.
            const newFromId = proposePayload.from_knowledge_id;
            const newToId = proposePayload.to_knowledge_id;
            return {
              op: 'supersede',
              supersededEdgeId,
              confidence,
              affectedRefs,
              newFromId,
              newToId,
              endpointIds: Array.from(new Set([newFromId, newToId])),
            };
          }

          const fromId =
            decision === 'reverse'
              ? proposePayload.to_knowledge_id
              : proposePayload.from_knowledge_id;
          const toId =
            decision === 'reverse'
              ? proposePayload.from_knowledge_id
              : proposePayload.to_knowledge_id;
          const relationType =
            decision === 'change_type'
              ? (new_relation_type as string)
              : proposePayload.relation_type;
          const endpointIds = Array.from(new Set([fromId, toId]));
          // Fast-fail before the decision transaction; the locks re-assert the same
          // invariants inside the effect.
          await assertEdgeEndpointsValid(db, fromId, toId, endpointIds);
          return {
            op: 'create',
            fromId,
            toId,
            relationType,
            weight: proposePayload.weight ?? 1,
            endpointIds,
          };
        },
        effect: async (
          { tx, writeRate },
          prepared,
        ): Promise<ProposalAcceptEffectOutcome<KnowledgeEdgeProposalDecisionResult>> => {
          const now = new Date();
          const rateEventId = createId();

          if (prepared.op === 'archive') {
            const generateEventId = createId();
            const writtenRateId = await writeRate({
              id: rateEventId,
              subject: rateSubject,
              created_at: now,
              payload: { edge_op: 'archive' },
            });
            const archived = await archiveKnowledgeEdgeFromEvents(tx, prepared.archiveEdgeId, {
              event_id: generateEventId,
              caused_by_event_id: proposeEventId,
              propose_event_id: proposeEventId,
              reasoning: proposePayload.reasoning ?? null,
            });
            if (!archived.archived) {
              throw new ApiError(
                'conflict',
                `knowledge_edge ${prepared.archiveEdgeId} is already archived`,
                409,
              );
            }
            return {
              status: 'accepted',
              result: {
                kind: 'knowledge_edge',
                rate_event_id: writtenRateId,
                generate_event_id: generateEventId,
                edge_id: prepared.archiveEdgeId,
              },
            };
          }

          if (prepared.op === 'supersede') {
            await acquireEdgeEndpointLocks(
              tx,
              prepared.newFromId,
              prepared.newToId,
              prepared.endpointIds,
            );

            // NOWAIT: blocking here while holding endpoint locks could deadlock with a merge.
            const oldEdge = (
              await tx
                .select()
                .from(knowledge_edge)
                .where(eq(knowledge_edge.id, prepared.supersededEdgeId))
                .limit(1)
                .for('update', { noWait: true })
            )[0];
            if (!oldEdge || oldEdge.archived_at !== null) {
              throw new ApiError(
                'conflict',
                `superseded knowledge_edge is no longer live: ${prepared.supersededEdgeId}`,
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
                  ? `supersede candidate duplicates target edge ${prepared.supersededEdgeId}`
                  : `supersede candidate does not touch target edge ${prepared.supersededEdgeId}`,
                400,
              );
            }

            const writtenRateId = await writeRate({
              id: rateEventId,
              subject: rateSubject,
              created_at: now,
              payload: { edge_op: 'supersede' },
            });
            const result = await applyApprovedEdgeSupersede(tx, {
              candidate: {
                from_knowledge_id: proposePayload.from_knowledge_id,
                to_knowledge_id: proposePayload.to_knowledge_id,
                relation_type: proposePayload.relation_type,
                weight: proposePayload.weight ?? 0.5,
                reasoning: proposePayload.reasoning ?? SUPERSEDE_DEFAULT_REASON,
              },
              supersededEdgeId: prepared.supersededEdgeId,
              decision: {
                action: 'SUPERSEDE',
                neighbor_index: proposePayload.supersede_neighbor_index ?? null,
                superseded_edge_id: prepared.supersededEdgeId,
                confidence: prepared.confidence,
                reason: proposePayload.reasoning ?? SUPERSEDE_DEFAULT_REASON,
              },
              affectedRefs: prepared.affectedRefs,
              proposeEventId,
            });

            // Gate after archiving, against the post-supersede mesh. A reject rolls all back.
            await runEdgeTopologyGate(tx, result.edgeId, { translateReject: true });

            return {
              status: 'accepted',
              result: {
                kind: 'knowledge_edge',
                rate_event_id: writtenRateId,
                generate_event_id: result.generateEventId,
                edge_id: result.edgeId,
              },
            };
          }

          // Endpoint locks inside the effect, directly after the decision lock: row
          // locks NOWAIT, then the knowledge_edge advisory, then revalidation.
          await acquireEdgeEndpointLocks(tx, prepared.fromId, prepared.toId, prepared.endpointIds);

          const edgeId = createId();
          const generateEventId = createId();
          const writtenRateId = await writeRate({
            id: rateEventId,
            subject: rateSubject,
            created_at: now,
            payload: {
              ...(decision === 'reverse' ? { new_direction_reversed: true } : {}),
              ...(decision === 'change_type' ? { new_relation_type: prepared.relationType } : {}),
            },
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
              from_knowledge_id: prepared.fromId,
              to_knowledge_id: prepared.toId,
              relation_type: prepared.relationType,
              weight: prepared.weight,
              // Null, not '', so the event folds losslessly into the row.
              reasoning: proposePayload.reasoning ?? null,
              propose_event_id: proposeEventId,
            },
            caused_by_event_id: proposeEventId,
            created_at: now,
          });

          await runEdgeTopologyGate(tx, edgeId);
          return {
            status: 'accepted',
            result: {
              kind: 'knowledge_edge',
              rate_event_id: writtenRateId,
              generate_event_id: generateEventId,
              edge_id: edgeId,
            },
          };
        },
      });

    if (edgeOp === 'archive') return accept();
    const fromId =
      decision === 'reverse' ? proposePayload.to_knowledge_id : proposePayload.from_knowledge_id;
    const toId =
      decision === 'reverse' ? proposePayload.from_knowledge_id : proposePayload.to_knowledge_id;
    const relationType =
      decision === 'change_type' ? (new_relation_type as string) : proposePayload.relation_type;
    // The wrapper retries NOWAIT contention and maps unique violations to 409.
    // Retrying re-runs the whole template: the fast replay re-checks the rate,
    // prepare re-runs, and the rolled-back decision transaction leaves nothing
    // behind to replay.
    return withEdgeEndpointLockRetry(accept, {
      uniqueViolationMessage: `edge already exists: ${fromId} --${relationType}--> ${toId}`,
    });
  })();

  return run.result;
}
