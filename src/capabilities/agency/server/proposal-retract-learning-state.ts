import { and, eq, sql } from 'drizzle-orm';
import { LearningItemStateRestoreExperimental } from '@/core/schema/event/learning-item-events';
import type { Tx } from '@/db/client';
import { completion_evidence, learning_item } from '@/db/schema';
import type { ProposalRetractInput } from '@/kernel/proposals';
import { applyLearningItemRepair } from './learning-item-projection-port';
export interface LearningStateRetractRuntime {
  findExistingRateEvent: (
    tx: Tx,
    proposalId: string,
  ) => Promise<{ decision: string; payload: unknown } | null>;
}

interface PriorLearningItemState {
  materialized_learning_item_id?: unknown;
  materialized_prior_status?: unknown;
  materialized_prior_completed_at?: unknown;
}

function priorCompletedAt(
  payload: PriorLearningItemState,
  legacyFallback: Date | null,
): Date | null {
  if (typeof payload.materialized_prior_completed_at === 'string') {
    return new Date(payload.materialized_prior_completed_at);
  }
  return typeof payload.materialized_prior_status === 'string' ? null : legacyFallback;
}

export async function retractCompletionProposal(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: LearningStateRetractRuntime,
): Promise<void> {
  const rate = await runtime.findExistingRateEvent(tx, input.proposalId);
  if (rate?.decision !== 'accept') return;

  const payload = rate.payload as PriorLearningItemState;
  const learningItemId = payload.materialized_learning_item_id;
  if (typeof learningItemId !== 'string' || learningItemId.length === 0) return;

  const item = (
    await tx
      .select({ id: learning_item.id })
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), eq(learning_item.status, 'done')))
      .for('update')
  )[0];
  if (item) {
    await restorePriorState(tx, input, learningItemId, payload, 'done', 'in_progress', null);
  }
  await tx
    .delete(completion_evidence)
    .where(
      and(
        eq(completion_evidence.learning_item_id, learningItemId),
        eq(completion_evidence.path, 'ai_propose'),
        sql`${completion_evidence.evidence_json} ->> 'proposal_id' = ${input.proposalId}`,
      ),
    );
}

export async function retractRelearnProposal(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: LearningStateRetractRuntime,
): Promise<void> {
  const rate = await runtime.findExistingRateEvent(tx, input.proposalId);
  if (rate?.decision !== 'accept') return;

  const payload = rate.payload as PriorLearningItemState;
  const learningItemId = payload.materialized_learning_item_id;
  if (typeof learningItemId !== 'string' || learningItemId.length === 0) return;

  const item = (
    await tx
      .select({ id: learning_item.id })
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), eq(learning_item.status, 'in_progress')))
      .for('update')
  )[0];
  if (!item) return;

  await restorePriorState(
    tx,
    input,
    learningItemId,
    payload,
    'in_progress',
    'done',
    input.correction_at,
  );
}

async function restorePriorState(
  tx: Tx,
  input: ProposalRetractInput,
  itemId: string,
  payload: PriorLearningItemState,
  expectedStatus: 'done' | 'in_progress',
  fallbackStatus: 'done' | 'in_progress',
  fallbackCompletedAt: Date | null,
): Promise<void> {
  await applyLearningItemRepair(
    tx,
    LearningItemStateRestoreExperimental.parse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_state_restore',
      subject_kind: 'learning_item',
      subject_id: itemId,
      outcome: 'success',
      caused_by_event_id: input.proposalId,
      payload: {
        expected_status: expectedStatus,
        status:
          typeof payload.materialized_prior_status === 'string'
            ? payload.materialized_prior_status
            : fallbackStatus,
        completed_at: priorCompletedAt(payload, fallbackCompletedAt)?.toISOString() ?? null,
      },
    }),
    input.correction_at,
  );
}
