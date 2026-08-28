import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { copilotTaskSpec } from './agent';
import { copilotCorrectionIntentTaskSpec } from './correction-intent';
import { copilotEvidenceReviewTaskSpec, copilotEvidenceVerificationTaskSpec } from './evidence';
import { copilotResearchTaskSpec } from './research';
import { teachingTurnTaskSpec } from './teaching-turn';

export const copilotTaskSpecs = defineOwnedTaskSpecs('copilot', {
  CopilotCorrectionIntentTask: copilotCorrectionIntentTaskSpec,
  CopilotEvidenceReviewTask: copilotEvidenceReviewTaskSpec,
  CopilotEvidenceVerificationTask: copilotEvidenceVerificationTaskSpec,
  CopilotTask: copilotTaskSpec,
  CopilotResearchTask: copilotResearchTaskSpec,
  TeachingTurnTask: teachingTurnTaskSpec,
});
