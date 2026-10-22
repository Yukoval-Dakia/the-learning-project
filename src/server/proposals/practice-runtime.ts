/**
 * Stable proposal-service surface for the practice capability: the operations
 * practice owns, without exposing the proposal module's internals.
 */

export type { ProposalInboxRow } from '@/kernel/proposals/inbox';
export {
  hasProposalWithCooldownKey,
  listProposalInboxRows,
  pendingProposalWithCooldown,
} from '@/kernel/proposals/inbox';
export { writeVariantQuestionProposal } from '@/kernel/proposals/producers';
export {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
export {
  acquireProposalDecisionLock,
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  findExistingRateEvent,
  requiredString,
} from './applier-helpers';
export { writeProposalRateEvent } from './owner-runtime';
