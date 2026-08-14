import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';

export const knowledgeTaskSpecs = defineOwnedTaskSpecs('knowledge', {
  KnowledgeEdgeProposeTask: defineTransitionalTask(legacyTaskDefinitions.KnowledgeEdgeProposeTask),
  FrontierPrerequisiteTask: defineTransitionalTask(legacyTaskDefinitions.FrontierPrerequisiteTask),
  SessionSummaryTask: defineTransitionalTask(legacyTaskDefinitions.SessionSummaryTask),
  LearningIntentOutlineTask: defineTransitionalTask(
    legacyTaskDefinitions.LearningIntentOutlineTask,
  ),
  KnowledgeReviewTask: defineTransitionalTask(legacyTaskDefinitions.KnowledgeReviewTask),
  GoalScopeTask: defineTransitionalTask(legacyTaskDefinitions.GoalScopeTask),
  MindModelInductionTask: defineTransitionalTask(legacyTaskDefinitions.MindModelInductionTask),
  ConjectureGroupingTask: defineTransitionalTask(legacyTaskDefinitions.ConjectureGroupingTask),
  ConjectureProbeAuthorTask: defineTransitionalTask(
    legacyTaskDefinitions.ConjectureProbeAuthorTask,
  ),
  ConjectureProbeReviewTask: defineTransitionalTask(
    legacyTaskDefinitions.ConjectureProbeReviewTask,
  ),
});
