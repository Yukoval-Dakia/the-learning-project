// Stable server contract for consumers outside the notes capability.

export type {
  ArtifactCorrectionState,
  ArtifactCorrectionStatus,
} from './server/artifact-corrections';
export {
  activeArtifactCorrectionStatus,
  getArtifactCorrectionState,
  getArtifactCorrectionStates,
} from './server/artifact-corrections';
export { emitArtifactLifecycleEvent } from './server/artifacts/mutation-events';
export type { BacklinksByArtifactType } from './server/block-refs';
export {
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from './server/block-refs';
// YUK-878 — the teaching context loader (copilot capability) projects an
// artifact's body blocks into note sections; expose the single projection
// instead of a deep import into notes/server.
export { bodyBlocksToNoteSections } from './server/body-blocks';
// YUK-1007 — notes 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { notesConfigEffectiveFacts } from './server/config-effective-facts';
export type {
  CreateLearningIntentNoteFn,
  CreateLearningIntentNoteInput,
} from './server/learning-intent-note';
export { createLearningIntentNote } from './server/learning-intent-note';
export { getLiveArtifactType } from './server/live-artifact-reference';
export {
  NOTE_HANDOFF_ACTION,
  dispatchNoteGeneration,
  writeNoteGenerationIntent,
} from './server/note-handoff';
export {
  type PersistNoteRefineApplyResult,
  listNoteRefineChanges,
  persistNoteRefineApply,
  undoNoteRefineApplyEvent,
} from './server/note-refine-apply';
export {
  enqueueDreamingNoteRefine,
  enqueueMasteryNoteRefine,
  enqueueNoteRefineTrigger,
} from './server/note-refine-triggers';
export type { NoteSummary } from './server/notes-read';
export {
  interactiveForKnowledge,
  listNotes,
  notesForKnowledge,
} from './server/notes-read';
export type { NoteUpdateAcceptResult } from './server/proposal-accept-applier';
export { archiveProposalArtifacts } from './server/proposal-artifacts';
