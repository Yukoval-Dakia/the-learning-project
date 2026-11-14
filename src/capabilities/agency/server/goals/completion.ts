import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { nextProjectionEventTime } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  asPlainRecord,
  ensureAcceptOnly,
  requiredString,
} from '@/kernel/proposals/applier-helpers';
import { readStoredCompletionReceipt } from '@/kernel/proposals/completion-receipt';
import { runProposalAccept } from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  type ProposalRetractInput,
  requireLaterProposalCorrection,
} from '@/kernel/proposals/types';
import {
  rethrowNativeMasteryBusy,
  withFencedNativeMasteryRead,
} from '@/kernel/read-models/native-mastery-basis';
import { completionSourcesCurrent } from '@/kernel/read-models/usage-policy';
import { mutateGoal } from '@/kernel/records/goal-commands';
import {
  originalCompletionEvidenceStillCurrent,
  readCompletionReceipt,
} from '../learning-item-completion-policy';
import type { AgencyApplierOpts } from '../proposal-appliers';
import type { LearningStateRetractRuntime } from '../proposal-retract-learning-state';

export interface GoalCompletionAcceptResult {
  kind: 'completion';
  rate_event_id: string;
  goal_id: string;
  idempotent?: boolean;
}

export async function acceptGoalCompletionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: AgencyApplierOpts,
): Promise<GoalCompletionAcceptResult> {
  ensureAcceptOnly('completion', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const goalId = requiredString(change.goal_id, 'goal_id', proposalId);
  if (proposal.target.subject_kind !== 'goal' || proposal.target.subject_id !== goalId)
    throw new ApiError('conflict', 'completion target does not match goal', 409);
  if (opts.actor && (opts.actor.kind !== 'user' || opts.actor.ref !== 'self'))
    throw new ApiError('conflict', 'completion requires a human decision', 409);
  const { result } = await runProposalAccept(db, proposalId, {
    proposal,
    userNote: opts.user_note,
    signal: 'after_commit',
    replay: async (rate): Promise<GoalCompletionAcceptResult> => ({
      kind: 'completion',
      rate_event_id: rate.id,
      goal_id: goalId,
      idempotent: true,
    }),
    effect: async ({ tx, writeRate }) =>
      withFencedNativeMasteryRead(tx, async (reader) => {
        const original = await readStoredCompletionReceipt(tx, proposalId, 'goal');
        if (!original || original.item_id !== goalId)
          throw new ApiError('conflict', 'completion has no verified goal receipt', 409);
        const current = await readCompletionReceipt(
          tx,
          reader,
          goalId,
          new Date(),
          original.sources.nodes,
          'goal',
        );
        if (
          !current ||
          !(await completionSourcesCurrent(tx, original.sources)) ||
          !originalCompletionEvidenceStillCurrent(original, current)
        )
          throw new ApiError('conflict', 'completion evidence is no longer current', 409);
        const now = await nextProjectionEventTime(tx, 'goal', goalId, new Date());
        await mutateGoal(tx, goalId, {
          kind: 'status',
          status: 'done',
          actorRef: 'goal-completion',
          causedByEventId: proposalId,
          now,
        });
        const rateEventId = await writeRate({
          created_at: now,
          payload: {
            materialized_goal_id: goalId,
            materialized_goal_prior_status: 'active',
            materialized_goal_version: current.item_version + 1,
          },
        });
        return {
          status: 'accepted' as const,
          result: { kind: 'completion' as const, rate_event_id: rateEventId, goal_id: goalId },
        };
      }),
  }).catch(rethrowNativeMasteryBusy);
  return result;
}

export async function retractGoalCompletionProposal(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: LearningStateRetractRuntime,
): Promise<void> {
  const rate = await runtime.findExistingRateEvent(tx, input.proposalId);
  if (rate?.decision !== 'accept') return;
  const payload = asPlainRecord(rate.payload);
  const goalId = requiredString(
    payload.materialized_goal_id,
    'materialized_goal_id',
    input.proposalId,
  );
  if (goalId !== input.proposal.payload.target.subject_id)
    throw new ApiError('conflict', 'completion target does not match goal', 409);
  const [current] = await tx.select().from(goal).where(eq(goal.id, goalId)).for('update');
  if (current?.status !== 'done') return;
  if (
    payload.materialized_goal_prior_status !== 'active' ||
    payload.materialized_goal_version !== current.version
  )
    throw new ApiError('conflict', 'goal changed after completion; cannot retract', 409);
  requireLaterProposalCorrection(input.correction_at, current.updated_at);
  const correctionId = requiredString(
    input.correction_event_id,
    'correction_event_id',
    input.proposalId,
  );
  await mutateGoal(tx, goalId, {
    kind: 'status',
    status: 'active',
    actorRef: 'goal-completion-retract',
    causedByEventId: correctionId,
    now: input.correction_at,
  });
}
