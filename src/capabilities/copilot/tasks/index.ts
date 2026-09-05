import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { copilotTaskSpec } from './agent';
import { copilotResearchTaskSpec } from './research';
import { teachingTurnTaskSpec } from './teaching-turn';

export const copilotTaskSpecs = defineOwnedTaskSpecs('copilot', {
  CopilotTask: copilotTaskSpec,
  CopilotResearchTask: copilotResearchTaskSpec,
  TeachingTurnTask: teachingTurnTaskSpec,
});
