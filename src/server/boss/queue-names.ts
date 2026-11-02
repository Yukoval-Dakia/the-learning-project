// Import-free on purpose. A unit test that shares a queue name must not pull the boss client.

/**
 * Producer and consumer import this one string. A renamed literal would send into a queue with no worker.
 */
export const COPILOT_NUDGE_EVALUATE_QUEUE = 'copilot_nudge_evaluate';
