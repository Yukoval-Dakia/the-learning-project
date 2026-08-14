import { and, eq } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { goal } from '@/db/schema';
import type { ProposalRetractInput } from '@/kernel/proposals';
export interface GoalRetractRuntime {
  assertCurrentGoalParity: (tx: Tx, goalId: string) => Promise<void>;
  hasGoalGenesisAnchor: (tx: Tx, goalId: string) => Promise<boolean>;
  projectGoalGuarded: (tx: Tx, goalId: string) => Promise<unknown>;
  projectionIsWriter: (
    entity?: 'artifact' | 'goal' | 'learning_item' | 'mistake_variant' | 'question_block',
  ) => boolean;
}

export async function retractGoalScopeProposal(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: GoalRetractRuntime,
): Promise<void> {
  const goalId = input.proposal.payload.target.subject_id;
  if (!goalId) return;

  await tx.select({ id: goal.id }).from(goal).where(eq(goal.id, goalId)).for('update');
  const wasEventSourced = await runtime.hasGoalGenesisAnchor(tx, goalId);
  if (runtime.projectionIsWriter('goal')) {
    await runtime.projectGoalGuarded(tx, goalId);
    return;
  }

  await tx
    .update(goal)
    .set({ status: 'dormant', updated_at: input.correction_at })
    .where(and(eq(goal.id, goalId), eq(goal.status, 'active')));
  if (wasEventSourced) {
    await runtime.assertCurrentGoalParity(tx, goalId);
  }
}
