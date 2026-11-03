// Copilot conversation event actions. Stored in event.action and matched by SQL,
// replay, revert and retention, so the values are persisted wire: never rename.
// `experimental:` actions parse through the generic ExperimentalEvent escape hatch,
// so they need no schema change; their payloads are free-form per event.

export const COPILOT_USER_ASK_ACTION = 'experimental:copilot_user_ask';
export const COPILOT_CHIP_TRIGGER_ACTION = 'experimental:copilot_chip_trigger';
export const COPILOT_REPLY_ACTION = 'experimental:copilot_reply';

/** User-role turn roots that open a copilot_run: typed asks and chip triggers. */
export const COPILOT_ASK_ACTIONS = [COPILOT_USER_ASK_ACTION, COPILOT_CHIP_TRIGGER_ACTION] as const;
