import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { blockAssemblyTaskSpec } from './block-assembly';
import { coldStartPlacementBridgeTaskSpec } from './cold-start-bridge';
import { mistakeEnrollTaskSpec } from './mistake-enroll';
import { profileCriticTaskSpec } from './profile-critic';
import { structureTaskSpec } from './structure';
import { taggingTaskSpec } from './tagging';
import { visionExtractTaskHeavySpec, visionExtractTaskSpec } from './vision';

export const ingestionTaskSpecs = defineOwnedTaskSpecs('ingestion', {
  VisionExtractTask: visionExtractTaskSpec,
  VisionExtractTaskHeavy: visionExtractTaskHeavySpec,
  StructureTask: structureTaskSpec,
  MistakeEnrollTask: mistakeEnrollTaskSpec,
  TaggingTask: taggingTaskSpec,
  ColdStartPlacementBridgeTask: coldStartPlacementBridgeTaskSpec,
  BlockAssemblyTask: blockAssemblyTaskSpec,
  ProfileCriticTask: profileCriticTaskSpec,
});
