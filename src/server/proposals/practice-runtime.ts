/**
 * Stable proposal-service surface for the practice capability.
 *
 * It keeps inbox storage, decision locking and signal bookkeeping private to
 * the proposal service while exposing the product operations practice owns.
 */
export {
  acquireProposalDecisionLock,
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  findExistingRateEvent,
  requiredString,
} from './applier-helpers';
export { hasProposalWithCooldownKey, listProposalInboxRows } from './inbox';
export type { ProposalInboxRow } from './inbox';
export { writeVariantQuestionProposal } from './producers';
export { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';
export {
  assertCurrentMistakeVariantParity,
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
  projectionIsWriter,
  writeProposalRateEvent,
} from './owner-runtime';
