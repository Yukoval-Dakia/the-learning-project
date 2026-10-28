// Per-turn actions: 撤回本轮更改 (cascade revert of that turn's effects), the refresh-only retry after
// a landed revert, 更正这轮, and the teaching 「重做 / 回看前置」 chip (a KPI event, not a chat turn).

import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import { saveCopilotDerivationPreference } from '../durable-reconnect-storage';
import type { CompanionCtx } from './companion-context';
import { plainRevertError } from './plain-errors';

export interface TurnActions {
  revert: (checkpointEventId: string) => Promise<void>;
  retryRefresh: () => Promise<void>;
  acceptCorrectiveChip: (
    sessionId: string,
    questionId: string,
    replyEventId?: string,
  ) => Promise<void>;
  selectCorrection: (turnId: string, turnNumber: number) => void;
  clearCorrection: () => void;
  setDraft: (draft: string) => void;
  setPolicy: (policy: DerivationPolicyT) => void;
  setListOpen: (open: boolean) => void;
}

const CHIP_ACK_MS = 4_000;

export function createTurnActions(ctx: CompanionCtx): TurnActions {
  async function revert(checkpointEventId: string) {
    ctx.set({ revertPendingId: checkpointEventId, error: null, refreshFailed: false });
    try {
      try {
        await ctx.client.revertCheckpoint(checkpointEventId);
      } catch (cause) {
        // Nothing landed; the button re-enables so a retriable failure can be retried.
        ctx.set({ error: plainRevertError(cause) });
        return;
      }
      // The revert landed. From here a failure is only the refresh, never "撤回失败".
      try {
        ctx.internals.activeSkill = null;
        ctx.set({ skillKnowledgeId: null });
        await ctx.runs.refetchTurns();
      } catch {
        ctx.set({ refreshFailed: true });
      }
    } finally {
      if (ctx.get().revertPendingId === checkpointEventId) ctx.set({ revertPendingId: null });
    }
  }

  async function retryRefresh() {
    try {
      ctx.internals.activeSkill = null;
      ctx.set({ skillKnowledgeId: null });
      if (await ctx.runs.refetchTurns()) ctx.set({ refreshFailed: false });
    } catch {
      // The revert is already durable; keep the refresh banner up.
    }
  }

  async function acceptCorrectiveChip(
    sessionId: string,
    questionId: string,
    replyEventId?: string,
  ) {
    ctx.set({ chipPending: questionId });
    try {
      await ctx.client.acceptTeachingChip(sessionId, {
        suggestion_kind: 'corrective',
        chip_label: '重做 / 回看前置',
        ...(replyEventId ? { source_event_id: replyEventId } : {}),
      });
      ctx.set({ chipAcked: questionId });
      window.setTimeout(() => {
        if (ctx.get().chipAcked === questionId) ctx.set({ chipAcked: null });
      }, CHIP_ACK_MS);
    } catch {
      // A pure KPI signal: a transient failure stays silent and the chip can be clicked again.
    } finally {
      if (ctx.get().chipPending === questionId) ctx.set({ chipPending: null });
    }
  }

  return {
    revert,
    retryRefresh,
    acceptCorrectiveChip,
    selectCorrection: (turnId, turnNumber) => ctx.set({ correctionTarget: { turnId, turnNumber } }),
    clearCorrection: () => ctx.set({ correctionTarget: null }),
    setDraft: (draft) => ctx.set({ draft }),
    setPolicy: (policy) => {
      ctx.set({ derivationPolicy: policy });
      saveCopilotDerivationPreference(policy);
    },
    setListOpen: (open) => ctx.set({ listOpen: open }),
  };
}
