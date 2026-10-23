// Arriving at the companion: once per mount, the browser-held state comes back (the policy
// preference and every exact pre-202 tuple, shown for 恢复 / 不再恢复 — nothing auto-retries); and
// each open request from a page is claimed once (skill context, nudge opening line, prefill).

import type { CopilotOpenRequest } from '@/ui/lib/use-copilot-dwell';
import {
  discardLegacyDurableCopilotReconnect,
  loadCopilotDerivationPreference,
  loadPersistedPendingCopilotTurns,
} from '../durable-reconnect-storage';
import { type CompanionCtx, nextMessageId } from './companion-context';
import { selectionValidated } from './companion-state';
import { RESTORED_PENDING_COPY } from './plain-errors';

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
      error: RESTORED_PENDING_COPY,
    })),
    currentSessionId: recoverySessionId,
    selectionOrigin: 'recovery',
    optimisticSession: {
      id: recoverySessionId,
      status: 'active',
      title: '正在恢复的对话',
      created_at: now,
      updated_at: now,
    },
  });
  ctx.updateMessages(ctx.sender.pendingMessagesForSession(recoverySessionId));
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
    // The nudge headline is the companion's opening line (never a learner bubble), seeded only
    // into an empty conversation; its ingestion session is the first reply's ambient focus.
    const { headline, session_id } = request.nudge;
    internals.nudgeSession = session_id;
    ctx.updateMessages((previous) =>
      previous.length === 0 ? [{ id: nextMessageId(), role: 'ai', text: headline }] : previous,
    );
  }
  requestOpen();
  const prefill = request.prefill;
  if (!prefill) return;
  if (request.prefill_mode !== 'compose' && selectionValidated(ctx.get())) {
    void ctx.sender.send(prefill);
    return;
  }
  // Compose handoffs never auto-send, and a cold open cannot send yet: append to the draft.
  const draft = ctx.get().draft;
  ctx.set({ draft: draft.trim() ? `${draft}\n${prefill}` : prefill });
}
