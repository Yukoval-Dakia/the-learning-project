import { COPILOT_ASK_ACTIONS } from '@/kernel/events/copilot-actions';

/** A system execution anchor; never a second learner message. */
export const COPILOT_RETRY_ACTION = 'experimental:copilot_run_retry';
export const COPILOT_RUN_ROOT_ACTIONS = [...COPILOT_ASK_ACTIONS, COPILOT_RETRY_ACTION] as const;
export const COPILOT_RETRY_WRITE_STARTED = 'copilot_run.retry_write_started';
