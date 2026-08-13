import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';

export const ingestionTaskSpecs = defineOwnedTaskSpecs('ingestion', {
  VisionExtractTask: defineTransitionalTask(legacyTaskDefinitions.VisionExtractTask),
  VisionExtractTaskHeavy: defineTransitionalTask(legacyTaskDefinitions.VisionExtractTaskHeavy),
  StructureTask: defineTransitionalTask(legacyTaskDefinitions.StructureTask),
  MistakeEnrollTask: defineTransitionalTask(legacyTaskDefinitions.MistakeEnrollTask),
  TaggingTask: defineTransitionalTask(legacyTaskDefinitions.TaggingTask),
  ColdStartPlacementBridgeTask: defineTransitionalTask(
    legacyTaskDefinitions.ColdStartPlacementBridgeTask,
  ),
  BlockAssemblyTask: defineTransitionalTask(legacyTaskDefinitions.BlockAssemblyTask),
  ProfileCriticTask: defineTransitionalTask(legacyTaskDefinitions.ProfileCriticTask),
});
