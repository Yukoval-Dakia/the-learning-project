import { defineOwnedTaskSpecs } from '@/ai/owned-task-specs';
import { copilotTaskSpec } from './agent';
import { teachingTurnTaskSpec, teachingTurnVisionTaskSpec } from './teaching-turn';

export const copilotTaskSpecs = defineOwnedTaskSpecs('copilot', {
  CopilotTask: copilotTaskSpec,
  TeachingTurnTask: teachingTurnTaskSpec,
  TeachingTurnVisionTask: teachingTurnVisionTaskSpec,
});
