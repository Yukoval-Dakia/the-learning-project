// YUK-710 (P0F/6) — fire-and-forget client for the teaching-brief interaction ledger.
//
// These two signals feed the two-week survival report. They are NON-BLOCKING telemetry:
// the brief was already shown / the action already started, so a failed POST must never
// disrupt the learner flow. Errors are swallowed, and the server is idempotent per
// brief × local day (seen) / brief × action_kind × local day (action), so a retry-on-render
// or a double-click cannot inflate the ledger. Nothing here renders to the learner — no
// count, streak, unread, or success-rate is ever surfaced (contract §8.1 / acceptance 4).
//
// Deliberately uses a BARE fetch, not apiFetch: apiFetch invalidates the internal token on a
// 401 (clearInternalToken → kicks the learner back to the token gate). Background telemetry must
// never have that power, so this manually attaches x-internal-token and silently drops a 401
// (and every other outcome). No other apiFetch semantics are reproduced (no retries). `keepalive`
// keeps the POST in flight across the navigate that immediately follows a scoped_practice click.

import type { BriefState, PrimaryActionKind } from '@/core/schema/conjecture';
import { getInternalToken } from '@/ui/lib/api';

// Compile-time mirror of the server superRefine (contracts.ts): result_event_id is REQUIRED for
// scoped_practice and FORBIDDEN for the other actions, so a caller can't send a malformed body.
export type TeachingBriefInteractionBody =
  | { type: 'brief_seen'; brief_id: string; brief_state: BriefState }
  | {
      type: 'primary_action_started';
      brief_id: string;
      action_kind: 'scoped_practice';
      result_event_id: string;
    }
  | {
      type: 'primary_action_started';
      brief_id: string;
      action_kind: Exclude<PrimaryActionKind, 'scoped_practice'>;
    };

/**
 * Post one interaction signal, swallowing any error. Deliberately returns void (not a
 * Promise) so callers use it inline in event handlers / effects without awaiting — the
 * ledger is best-effort and server-idempotent.
 */
export function reportBriefInteraction(body: TeachingBriefInteractionBody): void {
  const token = getInternalToken();
  // No token → send nothing. Never trigger the auth flow from telemetry (a real API call the
  // learner makes will surface the missing/expired token; this ledger stays silent).
  if (!token) return;
  void fetch('/api/prep-desk/brief/interaction', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': token },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    // Non-blocking telemetry: the interaction already happened client-side, and the server
    // write is idempotent, so a transient failure (or a 401 we deliberately ignore) is safe to drop.
  });
}
