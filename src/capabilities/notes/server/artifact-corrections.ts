// Compat re-export: the projection lives in the shared kernel read model, but
// notes-internal consumers and notes/public keep this path.

export type {
  ArtifactCorrectionState,
  ArtifactCorrectionStatus,
} from '@/kernel/read-models/artifact-corrections';
export {
  activeArtifactCorrectionStatus,
  getArtifactCorrectionState,
  getArtifactCorrectionStates,
} from '@/kernel/read-models/artifact-corrections';
