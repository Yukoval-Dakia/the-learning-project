// Artifact-scoped correction projection (ADR-0020 / ADR-0019).
//
// YUK-1571 — implementation moved verbatim to
// @/kernel/read-models/artifact-corrections (shared cross-capability read
// model); this file remains as an explicit compat re-export for
// notes-internal consumers and the notes/public surface.

export type {
  ArtifactCorrectionState,
  ArtifactCorrectionStatus,
} from '@/kernel/read-models/artifact-corrections';
export {
  activeArtifactCorrectionStatus,
  getArtifactCorrectionState,
  getArtifactCorrectionStates,
} from '@/kernel/read-models/artifact-corrections';
