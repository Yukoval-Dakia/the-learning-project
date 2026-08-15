import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
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
  KnowledgeReviewTask: knowledgeReviewTaskSpec,
});
