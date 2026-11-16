import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { RelationTypeSchemaT } from '@/core/schema/event/blocks';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
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
  // Legacy events predate this field and default to create. 'supersede' stays in
  // the union so a stale pending row parses and is rejected explicitly below.
  edge_op?: 'create' | 'archive' | 'supersede';
  archive_edge_id?: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight?: number;
  reasoning?: string;
};

type EdgeAcceptPrepared =
  | { readonly op: 'archive'; readonly archiveEdgeId: string }
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
    // The template answers a retracted proposal with no rate; this owner's callers expect
    // a decided rate id, so keep the not_pending conflict the pre-template path returned.
    if (dismissed.rate_event_id === null) {
      throw new ApiError(
        'not_pending',
        `proposal ${proposeEventId} is not pending (retracted); it cannot be dismissed`,
        409,
      );
    }
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

          // Supersede accepts are retired with the reconcile write path (YUK-1768):
          // a stale pending supersede still parses and can be dismissed, but accepting
          // it must not silently fall through to create semantics — fail closed.
          if (edgeOp === 'supersede') {
            throw new ApiError(
              'validation_error',
              `edge supersede proposal ${proposeEventId} is retired; dismiss it instead of accepting`,
              400,
            );
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
