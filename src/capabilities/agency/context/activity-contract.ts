import { LEARNING_ACTIVITY_ACTIONS } from '@/kernel/read-models/learner-activity';
export const CURATOR_ACTIVITY_ACTIONS = [
  ...LEARNING_ACTIVITY_ACTIONS,
  'experimental:copilot_user_ask',
  'experimental:copilot_chip_trigger',
];
