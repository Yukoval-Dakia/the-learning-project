import type { Tx } from '@/db/client';
import type { ProposalRetractInput } from '@/kernel/proposals';
import { mutateGoal } from '@/kernel/records/goal-commands';
import { goalIntentTopic, sealGoalScopeReceiptTx } from './goal-intent-request';

/** The surrounding proposal transaction owns the correction event; the goal owner settles it. */
export async function retractGoalScopeProposal(tx: Tx, input: ProposalRetractInput): Promise<void> {
  const goalId = input.proposal.payload.target.subject_id;
  if (goalId) await mutateGoal(tx, goalId, { kind: 'retract', now: input.correction_at });
  const topic = goalIntentTopic(input.proposal.payload);
  if (topic) await sealGoalScopeReceiptTx(tx, topic, input.proposalId);
}
