// Process-wide, not module-instance state. The API graph and the Start bundle
// each evaluate this file; a module slot installed on one graph is invisible to
// the other's writeEvents. Same constraint as kernel/host-operation.ts.
const WAKE_ACTIONS_KEY = '__loomSubscriptionWakeActions';

const EMPTY_WAKE_ACTIONS: ReadonlySet<string> = new Set();

function installedWakeActions(): ReadonlySet<string> | null {
  const host = globalThis as Record<string, unknown>;
  const value = host[WAKE_ACTIONS_KEY];
  return value instanceof Set ? (value as ReadonlySet<string>) : null;
}

/** Publish this process's subscribed-action union. A later call replaces the set. */
export function installSubscriptionWakeActions(actions: readonly string[]): void {
  const host = globalThis as Record<string, unknown>;
  host[WAKE_ACTIONS_KEY] = new Set(actions);
}

/**
 * Actions whose commit should NOTIFY the subscription dispatcher.
 * Empty until a host publishes the union taken from the capability manifests.
 * An uninstalled process does not fall back to a hand-written action list.
 * The minute cron still drains.
 */
export function subscriptionWakeActions(): ReadonlySet<string> {
  return installedWakeActions() ?? EMPTY_WAKE_ACTIONS;
}
