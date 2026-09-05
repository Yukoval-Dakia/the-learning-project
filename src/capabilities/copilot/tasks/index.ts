import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { copilotTaskSpec } from './agent';
import { copilotEvidenceReviewTaskSpec, copilotEvidenceVerificationTaskSpec } from './evidence';
import { copilotResearchTaskSpec } from './research';
import { teachingTurnTaskSpec } from './teaching-turn';

export const copilotTaskSpecs = defineOwnedTaskSpecs('copilot', {
  CopilotEvidenceReviewTask: copilotEvidenceReviewTaskSpec,
  CopilotEvidenceVerificationTask: copilotEvidenceVerificationTaskSpec,
  CopilotTask: copilotTaskSpec,
  CopilotResearchTask: copilotResearchTaskSpec,
  TeachingTurnTask: teachingTurnTaskSpec,
});
