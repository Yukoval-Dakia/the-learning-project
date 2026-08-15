export {
  artifactRowToCreateSnapshot,
  emitArtifactCreateEvent,
} from '@/kernel/artifacts';
export {
  type ArtifactLifecycleOp,
  type EmitArtifactLifecycleParams,
  type EmitBodyBlocksEditParams,
  emitArtifactBodyBlocksEditEvent,
  emitArtifactLifecycleEvent,
} from './artifacts/mutation-events';
