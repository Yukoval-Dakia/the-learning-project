import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { copilotTaskSpec } from './agent';
import { copilotDispatchTaskSpec } from './dispatch';
import { copilotEvidenceReviewTaskSpec, copilotEvidenceVerificationTaskSpec } from './evidence';
import { teachingTurnTaskSpec } from './teaching-turn';

export const copilotTaskSpecs = defineOwnedTaskSpecs('copilot', {
  CopilotDispatchTask: copilotDispatchTaskSpec,
  CopilotEvidenceReviewTask: copilotEvidenceReviewTaskSpec,
  CopilotEvidenceVerificationTask: copilotEvidenceVerificationTaskSpec,
  CopilotTask: copilotTaskSpec,
  TeachingTurnTask: teachingTurnTaskSpec,
});
