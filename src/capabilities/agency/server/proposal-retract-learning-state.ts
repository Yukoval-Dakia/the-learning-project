import { and, eq, sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { completion_evidence, learning_item } from '@/db/schema';
import type { ProposalRetractInput } from '@/kernel/proposals';
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
      .select({ id: learning_item.id, version: learning_item.version })
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), eq(learning_item.status, 'done')))
      .limit(1)
  )[0];
  if (item) {
    await tx
      .update(learning_item)
      .set({
        status:
          typeof payload.materialized_prior_status === 'string'
            ? payload.materialized_prior_status
            : 'in_progress',
        completed_at: priorCompletedAt(payload, null),
        updated_at: new Date(),
        version: item.version + 1,
      })
      .where(and(eq(learning_item.id, learningItemId), eq(learning_item.version, item.version)));
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
      .select({ id: learning_item.id, version: learning_item.version })
      .from(learning_item)
      .where(and(eq(learning_item.id, learningItemId), eq(learning_item.status, 'in_progress')))
      .limit(1)
  )[0];
  if (!item) return;

  await tx
    .update(learning_item)
    .set({
      status:
        typeof payload.materialized_prior_status === 'string'
          ? payload.materialized_prior_status
          : 'done',
      completed_at: priorCompletedAt(payload, new Date()),
      updated_at: new Date(),
      version: item.version + 1,
    })
    .where(and(eq(learning_item.id, learningItemId), eq(learning_item.version, item.version)));
}
