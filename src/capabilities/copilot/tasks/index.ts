import { legacyTaskDefinitions } from '@/ai/legacy-task-definitions';
import { defineOwnedTaskSpecs, defineTransitionalTask } from '@/ai/owned-task-specs';

export const copilotTaskSpecs = defineOwnedTaskSpecs('copilot', {
  CopilotDispatchTask: defineTransitionalTask(legacyTaskDefinitions.CopilotDispatchTask),
  CopilotEvidenceReviewTask: defineTransitionalTask(
    legacyTaskDefinitions.CopilotEvidenceReviewTask,
  ),
  CopilotEvidenceVerificationTask: defineTransitionalTask(
    legacyTaskDefinitions.CopilotEvidenceVerificationTask,
  ),
  CopilotTask: defineTransitionalTask(legacyTaskDefinitions.CopilotTask),
});
