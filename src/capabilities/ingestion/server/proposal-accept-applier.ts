import type { Db } from '@/db/client';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalAcceptResult,
} from '@/kernel/proposals';
import { ensureAcceptOnly } from '@/server/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import {
  type ImageCandidateAcceptDeps,
  acceptImageCandidateProposal,
} from './image-candidate-accept';
import {
  type LegacyRecordApplierOpts,
  acceptRecordLinksProposal,
  acceptRecordPromotionProposal,
} from './legacy-record-appliers';
import { type IngestionApplierOpts, acceptBlockMergeProposal } from './proposal-appliers';

type IngestionAcceptRuntime = IngestionApplierOpts &
  LegacyRecordApplierOpts & {
    imageCandidateDeps?: ImageCandidateAcceptDeps;
  };

function inboxView(input: ProposalAcceptInput): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(input: ProposalAcceptInput, runtime: unknown): IngestionAcceptRuntime {
  const seams = runtime && typeof runtime === 'object' ? (runtime as IngestionAcceptRuntime) : {};
  return {
    ...seams,
    decision: input.decision,
    user_note: input.user_note,
  };
}

function wrap(kind: string, result: unknown): ProposalAcceptResult {
  return { kind, result };
}

export const blockMergeProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    'block_merge',
    await acceptBlockMergeProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

export const imageCandidateProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) => {
  const options = runtimeOptions(input, runtime);
  ensureAcceptOnly('image_candidate', options);
  return wrap(
    'image_candidate',
    await acceptImageCandidateProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      options.imageCandidateDeps,
    ),
  );
};

export const recordLinksProposalAcceptApplier: ProposalAcceptApplier = async (db, input, runtime) =>
  wrap(
    'record_links',
    await acceptRecordLinksProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );

export const recordPromotionProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) =>
  wrap(
    'record_promotion',
    await acceptRecordPromotionProposal(
      db as Db,
      input.proposalId,
      inboxView(input),
      runtimeOptions(input, runtime),
    ),
  );
