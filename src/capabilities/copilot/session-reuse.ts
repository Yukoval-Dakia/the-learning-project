/**
 * Copilot session reuse-window predicate for the UI bootstrap auto-selection
 * (YUK-1340 P1).
 *
 * The shared 24h bound `COPILOT_REUSE_WINDOW_MS` is defined in `@/core/limits`
 * (single source of truth) and reached here via the `@/kernel/limits` facade so
 * the browser-side CopilotDock pulls in only this pure leaf — no server module
 * enters the SPA graph, and the server predicate (`findReusableCopilotConversation`
 * in src/server/session/conversation.ts) reads the SAME number from `@/core/limits`
 * without deep-importing this capability.
 *
 * This module holds the UI-side age predicate only; it mirrors the server's
 * `gte(updated_at, now - COPILOT_REUSE_WINDOW_MS)` clause.
 */
import { COPILOT_REUSE_WINDOW_MS } from '@/kernel/limits';

/**
 * Whether a session's `updated_at` falls within the Copilot reuse window.
 * Matches the server predicate: `gte(updated_at, now - COPILOT_REUSE_WINDOW_MS)`.
 *
 * Invalid / NaN dates return false (conservative: never auto-select on bad data).
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
