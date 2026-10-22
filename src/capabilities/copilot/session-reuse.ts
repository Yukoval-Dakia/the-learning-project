/**
 * Copilot session reuse-window predicate for the UI bootstrap auto-selection.
 *
 * `COPILOT_REUSE_WINDOW_MS` is defined once in `@/core/limits` and reached here
 * via the `@/kernel/limits` facade, so the browser-side companion pulls only
 * this pure leaf — no server module enters the SPA graph. The server predicate
 * (`findReusableCopilotConversation`) reads the SAME number from `@/core/limits`
 * without deep-importing this capability.
 */
import { COPILOT_REUSE_WINDOW_MS } from '@/kernel/limits';

/**
 * Whether a session's `updated_at` falls within the Copilot reuse window,
 * mirroring the server's `gte(updated_at, now - COPILOT_REUSE_WINDOW_MS)`.
 * Invalid / NaN dates return false (never auto-select on bad data).
 */
export function isWithinCopilotReuseWindow(
  updatedAt: string | Date,
  now: Date = new Date(),
): boolean {
  const updated = typeof updatedAt === 'string' ? new Date(updatedAt) : updatedAt;
  const updatedMs = updated.getTime();
  if (Number.isNaN(updatedMs)) return false;
  return updatedMs >= now.getTime() - COPILOT_REUSE_WINDOW_MS;
}
