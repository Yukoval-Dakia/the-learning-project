// Import-free on purpose. A unit test that shares a queue name must not pull the boss client.

/**
 * Producer and consumer import this one string. A renamed literal would send into a queue with no worker.
 */
export const COPILOT_NUDGE_EVALUATE_QUEUE = 'copilot_nudge_evaluate';

export const VERIFY_DISPATCH_RECOVERY_QUEUE = 'verify_dispatch_recover';

export const AGENT_WORKSPACE_SWEEP_QUEUE = 'agent_workspace_sweep';
