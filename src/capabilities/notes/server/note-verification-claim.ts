// Stable public surface for the note verification claim state machine, split by
// responsibility (YUK-888):
//   - note-verification-claim-reservation.ts — claim transitions (reservation,
//     provider-start, epoch supersede/discard) + fencing/epoch/token predicates
//     and the shared claim vocabulary.
//   - note-verification-claim-result.ts — provider-result staging, retry
//     release, ambiguity/deferral, and finalization.
//   - note-verification-claim-recovery.ts — recovery selection + preparation.
// Consumers import from this facade; the split modules stay Notes-internal.

export {
  listRecoverableNoteVerificationResults,
  prepareNoteVerificationResultRecovery,
} from './note-verification-claim-recovery';
export {
  NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT,
  type NoteVerificationLease,
  type NoteVerificationReservation,
  type StagedNoteVerification,
  discardReservedNoteVerificationClaim,
  markNoteVerificationProviderStarted,
  reserveNoteVerification,
  supersedeNoteVerificationEpoch,
} from './note-verification-claim-reservation';
export {
  deferNoteVerificationResultForRetry,
  finalizeNoteVerificationResult,
  markNoteVerificationAmbiguous,
  releaseNoteVerificationForRetry,
  releaseReservedNoteVerificationForRetry,
  stageNoteVerificationContractResult,
  stageNoteVerificationResult,
} from './note-verification-claim-result';
