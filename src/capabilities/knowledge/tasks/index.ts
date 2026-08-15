import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';
import {
  frontierPrerequisiteTaskSpec,
  knowledgeEdgeProposeTaskSpec,
  knowledgeReviewTaskSpec,
} from './knowledge-tasks';

export {
  frontierPrerequisiteTaskSpec,
  knowledgeEdgeProposeTaskSpec,
  knowledgeReviewTaskSpec,
} from './knowledge-tasks';

export const knowledgeTaskSpecs = defineOwnedTaskSpecs('knowledge', {
  KnowledgeEdgeProposeTask: knowledgeEdgeProposeTaskSpec,
  FrontierPrerequisiteTask: frontierPrerequisiteTaskSpec,
  SessionSummaryTask: defineTransitionalTask(legacyTaskDefinitions.SessionSummaryTask),
  KnowledgeReviewTask: knowledgeReviewTaskSpec,
});
