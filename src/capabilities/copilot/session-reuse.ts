/**
 * Copilot session reuse window — single source of truth (YUK-1340 P1).
 *
 * Shared between:
 *   - Server: `findReusableCopilotConversation` in src/server/session/conversation.ts
 *   - UI: bootstrap auto-selection in src/capabilities/copilot/ui/CopilotDock.tsx
 *
 * The UI cannot import from @/server/, so this leaf module holds the constant
 * both sides consume. The server predicate is `updated_at >= now - COPILOT_REUSE_WINDOW_MS`.
 */
export const COPILOT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
