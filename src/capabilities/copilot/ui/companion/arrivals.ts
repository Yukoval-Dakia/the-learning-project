// Arriving at the companion: once per mount, the browser-held state comes back (the policy
// preference and every exact pre-202 tuple: a recent one resends itself, an old one asks); and
// each open request from a page is claimed once (skill context, nudge opening line, prefill).

import type { CopilotOpenRequest } from '@/ui/lib/use-copilot-dwell';
import {
  discardLegacyDurableCopilotReconnect,
  loadCopilotDerivationPreference,
  loadPersistedPendingCopilotTurns,
} from '../durable-reconnect-storage';
import type { CompanionCtx } from './companion-context';
import { selectionValidated } from './companion-state';
import { RESTORED_PENDING_COPY } from './plain-errors';
import { canResendUnasked } from './turn-sender';

/** Once per mount: the policy preference and every exact pre-202 tuple. Accepted runs come
 *  from the server snapshot only. */
export function initializeFromStorage(ctx: CompanionCtx) {
  const { internals } = ctx;
  if (internals.storageInitialized) return;
  internals.storageInitialized = true;
  ctx.set({ derivationPolicy: loadCopilotDerivationPreference() });
  discardLegacyDurableCopilotReconnect();
  const restored = loadPersistedPendingCopilotTurns();
  const recoverySessionId = restored.at(-1)?.requestBody.session_id;
  if (!recoverySessionId) return;
  const now = new Date().toISOString();
  ctx.set({
    pendingTurns: restored.map((t) => ({
      ...t,
      dispatching: false,
      doubtful: true,
      error: RESTORED_PENDING_COPY,
    })),
    currentSessionId: recoverySessionId,
    selectionOrigin: 'recovery',
    optimisticSession: {
      id: recoverySessionId,
      status: 'active',
      title: '刚才的对话',
      created_at: now,
      updated_at: now,
    },
  });
  ctx.updateMessages(ctx.sender.pendingMessagesForSession(recoverySessionId));
  for (const turn of restored) {
    if (canResendUnasked(turn)) ctx.sender.retryPendingTurn(turn.idempotencyKey);
  }
}

export function handleOpenRequest(
  ctx: CompanionCtx,
  request: CopilotOpenRequest,
  requestOpen: () => void,
) {
  const { internals } = ctx;
  internals.activeSkill = request.skill_context ?? null;
  ctx.set({
    skillKnowledgeId:
      request.skill_context?.ref.kind === 'knowledge' ? request.skill_context.ref.id : null,
  });
  if (request.nudge) {
    // The nudge headline is the companion's next line (never a learner bubble), also in a
    // conversation with history: 看看 clears the nudge, so this is the only place it stays.
    // Its ingestion session is the first reply's ambient focus.
    const { headline, session_id, nudge_event_id } = request.nudge;
    internals.nudgeSession = session_id;
    const id = `nudge_${nudge_event_id}`;
    ctx.updateMessages((previous) =>
      previous.some((m) => m.id === id)
        ? previous
        : [
            ...previous,
            {
              id,
              role: 'ai',
              text: headline,
              nudge_line: true,
              session_id: ctx.get().currentSessionId ?? undefined,
            },
          ],
    );
  }
  requestOpen();
  const prefill = request.prefill;
  if (!prefill) return;
  if (request.prefill_mode !== 'compose' && selectionValidated(ctx.get())) {
    void ctx.sender.send(prefill);
    return;
  }
  // Compose handoffs never auto-send, and a cold open cannot send yet: append to the draft, so
  // nothing the learner typed is lost. A draft that is still exactly the last handed sentence
  // holds nothing of theirs, so the new one replaces it (改 then 撤回 is one ask, not two).
  const draft = ctx.get().draft;
  const untouched = draft.trim() === '' || draft === internals.handedDraft;
  internals.handedDraft = prefill;
  ctx.set({ draft: untouched ? prefill : `${draft}\n${prefill}` });
}
