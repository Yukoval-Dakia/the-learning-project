// judge_retraction accept 的组合根薄壳：把 ProposalAcceptApplier 的
// (input, runtime) 形参折成 acceptJudgeRetractionProposal 的实参。

import type { Db } from '@/db/client';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  type ProposalAcceptApplier,
  type ProposalAcceptInput,
  type ProposalAcceptResult,
  toProposalLifecycleResult,
} from '@/kernel/proposals/index';
import {
  type JudgeRetractionApplierOpts,
  acceptJudgeRetractionProposal,
} from './judge-retraction-applier';

function inboxView(input: { proposal: ProposalAcceptInput['proposal'] }): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(input: ProposalAcceptInput, runtime: unknown): JudgeRetractionApplierOpts {
  const seams =
    runtime && typeof runtime === 'object' ? (runtime as JudgeRetractionApplierOpts) : {};
  return {
    ...seams,
    decision: input.decision,
    user_note: input.user_note,
  };
}

export const judgeRetractionProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) => {
  const result = await acceptJudgeRetractionProposal(
    db as Db,
    input.proposalId,
    inboxView(input),
    runtimeOptions(input, runtime),
  );
  return { kind: result.kind, result: toProposalLifecycleResult(result) };
};
