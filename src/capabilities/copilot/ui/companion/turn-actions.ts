// Per-turn actions: 撤回本轮更改 (cascade revert of that turn's effects), the refresh-only retry after
// a landed revert, 更正这轮, and the teaching 「重做 / 回看前置」 chip (a KPI event, not a chat turn).

import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { saveCopilotDerivationPreference } from '../durable-reconnect-storage';
import { readAcceptance } from './acceptance';
import type { CompanionCtx } from './companion-context';
import { plainRetryError, plainRevertError } from './plain-errors';

export interface TurnActions {
  revert: (checkpointEventId: string) => Promise<void>;
  /** Send a failed turn's question again in place: same question row, a new reply. */
  retryFailedRun: (runId: string, sessionId: string) => Promise<void>;
  retryRefresh: () => Promise<void>;
  dismissError: () => void;
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

  async function retryFailedRun(runId: string, sessionId: string) {
    if (ctx.get().retryPendingRunId) return;
    ctx.set({ retryPendingRunId: runId, error: null, refreshFailed: false });
    try {
      let accepted: Awaited<ReturnType<typeof readAcceptance>>;
      try {
        // The server keys a resend on the failed run, so a repeat click finds the same one.
        const res = await ctx.client.retryRun(runId, randomId());
        accepted = await readAcceptance(res, undefined);
      } catch (cause) {
        if (ctx.get().currentSessionId !== sessionId) return;
        ctx.set({ error: plainRetryError(cause) });
        // A refusal means the button is out of date; the fresh read takes it away.
        if (cause instanceof ApiError && cause.code === 'retry_not_allowed') {
          await ctx.runs.refetchTurns().catch(() => undefined);
        }
        return;
      }
      if (ctx.get().currentSessionId === sessionId) {
        ctx.updateMessages((previous) =>
          previous.filter((m) => !(m.role === 'ai' && m.run_id === runId)),
        );
      }
      ctx.runs.trackAccepted({
        runId: accepted.runId,
        sessionId,
        location: accepted.location,
        derivationPolicy: accepted.policy,
      });
      // The question loses its undo once its run is replaced; the page reads that from the server.
      await ctx.runs.refetchTurns().catch(() => undefined);
    } finally {
      if (ctx.get().retryPendingRunId === runId) ctx.set({ retryPendingRunId: null });
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
    retryFailedRun,
    retryRefresh,
    dismissError: () => ctx.set({ error: null }),
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
