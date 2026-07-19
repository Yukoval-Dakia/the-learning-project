// YUK-710 (P0F/6) — fire-and-forget client for the teaching-brief interaction ledger.
//
// These two signals feed the two-week survival report. They are NON-BLOCKING telemetry:
// the brief was already shown / the action already started, so a failed POST must never
// disrupt the learner flow. Errors are swallowed, and the server is idempotent per
// brief × local day (seen) / brief × action_kind × local day (action), so a retry-on-render
// or a double-click cannot inflate the ledger. Nothing here renders to the learner — no
// count, streak, unread, or success-rate is ever surfaced (contract §8.1 / acceptance 4).

import type { BriefState, PrimaryActionKind } from '@/core/schema/conjecture';
import { apiFetch } from '@/ui/lib/api';

export type TeachingBriefInteractionBody =
  | { type: 'brief_seen'; brief_id: string; brief_state: BriefState }
  | {
      type: 'primary_action_started';
      brief_id: string;
      action_kind: PrimaryActionKind;
      // Present only for scoped_practice (the confirmed outcome's probe_result event id).
      result_event_id?: string;
    };

/**
 * Post one interaction signal, swallowing any error. Deliberately returns void (not a
 * Promise) so callers use it inline in event handlers / effects without awaiting — the
 * ledger is best-effort and server-idempotent.
 */
export function reportBriefInteraction(body: TeachingBriefInteractionBody): void {
  void apiFetch('/api/prep-desk/brief/interaction', {
    method: 'POST',
    body: JSON.stringify(body),
  }).catch(() => {
    // Non-blocking telemetry: the interaction already happened client-side, and the
    // server write is idempotent, so a transient failure is safe to drop.
  });
}
