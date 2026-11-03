import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { frontierPrerequisiteTaskSpec, knowledgeReviewTaskSpec } from './knowledge-tasks';

export { frontierPrerequisiteTaskSpec, knowledgeReviewTaskSpec } from './knowledge-tasks';

export const knowledgeTaskSpecs = defineOwnedTaskSpecs('knowledge', {
  FrontierPrerequisiteTask: frontierPrerequisiteTaskSpec,
  KnowledgeReviewTask: knowledgeReviewTaskSpec,
});
