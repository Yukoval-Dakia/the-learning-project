// Accepted runs: one reconnectable job-event subscription per run, the turns snapshot that restores
// every active run after reopen or reload, Stop, and reconnect. Execution is server-owned (ADR-0062):
// detaching a stream never cancels; only an explicit Stop does, and the stream stays attached until
// the cancelled terminal arrives.

import { ApiError } from '@/ui/lib/api';
import type { CopilotTurnsResponse } from '../copilot-client';
import { durableRunIdFromLocation } from '../durable-reconnect-storage';
import {
  copilotRunReplyMessageId,
  projectCopilotRunUpdate,
  reconcileCopilotSnapshotMessages,
} from '../message-projection';
import { nextNudgeSessionAfterTurn } from '../nudge-focus';
import { replayToMessages } from '../replay';
import { restoreSkillContext } from '../skill-lifecycle';
import { consumeDurableCopilotRun, createCopilotRunView } from '../subtask-events';
import type { ActiveRun, CompanionCtx } from './companion-context';
import type { RunSnapshot } from './companion-state';
import { plainError } from './plain-errors';
import { fallbackText, isTerminal, progressStage, reconnectCopy } from './run-copy';

/** Replay-last-N window (matches the turns route default). */
const REPLAY_LIMIT = 20;

export interface RunTracker {
  /** Track an accepted run (from a 202) and attach its stream. */
  trackAccepted: (run: Omit<ActiveRun, 'view' | 'stopPending' | 'cancelRequested'>) => void;
  detachSubscriptions: (sessionId?: string, notify?: boolean) => void;
  refetchTurns: () => Promise<boolean>;
  stopRun: (runId: string) => Promise<void>;
  reconnectRun: (runId: string) => void;
}

export function createRunTracker(ctx: CompanionCtx): RunTracker {
  const runs = ctx.internals.runs;

  function publishRuns() {
    const snapshots: RunSnapshot[] = [...runs.values()].map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      phase: run.view.phase,
      stage: progressStage(run.view),
      attached: run.controller !== undefined,
      stopPending: run.stopPending,
      cancelRequested: run.cancelRequested,
      ...(run.connectionError ? { connectionError: run.connectionError } : {}),
    }));
    ctx.set({ runs: snapshots });
  }

  /** A detached/background session may still settle; never project it into another conversation. */
  function applyRunView(run: ActiveRun) {
    if (ctx.get().currentSessionId !== run.sessionId) return;
    ctx.updateMessages((previous) =>
      projectCopilotRunUpdate(previous, {
        runId: run.runId,
        sessionId: run.sessionId,
        view: run.view,
        derivationPolicy: run.derivationPolicy,
        fallbackText: fallbackText(run),
        ...(run.userMessage ? { userMessage: run.userMessage } : {}),
      }),
    );
    if (run.view.phase === 'completed') {
      ctx.internals.nudgeSession = nextNudgeSessionAfterTurn(ctx.internals.nudgeSession, true);
    }
    if (isTerminal(run.view)) run.connectionError = undefined;
  }

  function detachSubscriptions(sessionId?: string, notify = true) {
    let changed = false;
    for (const run of runs.values()) {
      if (sessionId && run.sessionId !== sessionId) continue;
      if (!run.controller) continue;
      const controller = run.controller;
      run.controller = undefined;
      controller.abort();
      changed = true;
    }
    if (changed && notify) publishRuns();
  }

  function subscribeRun(runId: string) {
    const run = runs.get(runId);
    const s = ctx.get();
    if (!run || run.controller || isTerminal(run.view) || !s.visit.open) return;
    if (s.currentSessionId !== run.sessionId) return;
    const controller = new AbortController();
    run.controller = controller;
    run.connectionError = undefined;
    publishRuns();
    const owns = () => {
      const current = runs.get(runId);
      return current?.controller === controller ? current : undefined;
    };
    void consumeDurableCopilotRun({
      location: run.location,
      fetchResponse: (input, init) => ctx.client.fetchRunEvents(input, init),
      initialState: run.view,
      signal: controller.signal,
      onUpdate: (view) => {
        const current = owns();
        if (!current) return;
        current.view = view;
        applyRunView(current);
        publishRuns();
        if (isTerminal(view)) ctx.sessions.revalidateAutomaticSelection();
      },
    })
      .then((view) => {
        const current = owns();
        if (!current) return;
        current.view = view;
        applyRunView(current);
        if (isTerminal(view)) ctx.sessions.revalidateAutomaticSelection();
      })
      .catch((cause) => {
        const current = owns();
        if (!current || controller.signal.aborted) return;
        current.connectionError = reconnectCopy(cause);
        const replyId = copilotRunReplyMessageId(runId);
        ctx.updateMessages((previous) =>
          previous.map((m) => (m.id === replyId ? { ...m, streaming: false } : m)),
        );
      })
      .finally(() => {
        const current = runs.get(runId);
        if (current?.controller === controller) current.controller = undefined;
        publishRuns();
      });
  }

  function trackAccepted(accepted: Omit<ActiveRun, 'view' | 'stopPending' | 'cancelRequested'>) {
    const run: ActiveRun = runs.get(accepted.runId) ?? {
      ...accepted,
      view: createCopilotRunView(),
      stopPending: false,
      cancelRequested: false,
    };
    run.location = accepted.location;
    run.userMessage = accepted.userMessage;
    run.derivationPolicy = accepted.derivationPolicy;
    runs.set(accepted.runId, run);
    applyRunView(run);
    publishRuns();
    subscribeRun(accepted.runId);
  }

  function synchronizeSnapshot(
    sessionId: string,
    snapshot: CopilotTurnsResponse,
    knownWhenRequested: ReadonlySet<string>,
  ) {
    if (snapshot.session_id !== null && snapshot.session_id !== sessionId) return;
    const replayed = replayToMessages(snapshot.turns ?? []);
    const activeIds = new Set<string>();
    for (const item of snapshot.active_runs ?? []) {
      if (item.session_id !== sessionId) continue;
      if (durableRunIdFromLocation(item.events_url) !== item.run_id) continue;
      activeIds.add(item.run_id);
      const userMessage = replayed.find((m) => m.role === 'user' && m.id === item.run_id)?.text;
      const existing = runs.get(item.run_id);
      if (existing) {
        existing.location = item.events_url;
        existing.derivationPolicy = item.derivation_policy ?? 'allow';
        if (userMessage) existing.userMessage = userMessage;
        if (item.status === 'cancel_requested') existing.cancelRequested = true;
        continue;
      }
      const view = createCopilotRunView();
      if (item.status === 'started' || item.status === 'running') view.phase = 'running';
      if (item.status === 'cancel_requested') view.phase = 'cancel_requested';
      runs.set(item.run_id, {
        runId: item.run_id,
        sessionId,
        location: item.events_url,
        derivationPolicy: item.derivation_policy ?? 'allow',
        ...(userMessage ? { userMessage } : {}),
        view,
        stopPending: false,
        cancelRequested: item.status === 'cancel_requested',
      });
    }
    // Drop runs the snapshot no longer lists, but only ones known when the read started.
    for (const [runId, run] of runs) {
      if (run.sessionId !== sessionId || activeIds.has(runId) || !knownWhenRequested.has(runId))
        continue;
      run.controller?.abort();
      runs.delete(runId);
    }
    const retained = new Set(activeIds);
    for (const run of runs.values()) {
      if (run.sessionId === sessionId && !knownWhenRequested.has(run.runId))
        retained.add(run.runId);
    }
    // Restore the replayed mode first; updateMessages then folds the reconciled order on top.
    ctx.internals.activeSkill = restoreSkillContext(replayed, ctx.internals.activeSkill);
    const knowledge = [...replayed]
      .reverse()
      .find((m) => m.skill_context?.ref.kind === 'knowledge');
    if (knowledge?.skill_context) ctx.set({ skillKnowledgeId: knowledge.skill_context.ref.id });
    ctx.updateMessages((previous) => {
      let next = reconcileCopilotSnapshotMessages(previous, replayed, sessionId, retained);
      for (const runId of retained) {
        const run = runs.get(runId);
        if (!run) continue;
        next = projectCopilotRunUpdate(next, {
          runId,
          sessionId,
          view: run.view,
          derivationPolicy: run.derivationPolicy,
          fallbackText: fallbackText(run),
          ...(run.userMessage ? { userMessage: run.userMessage } : {}),
        });
      }
      return next;
    });
    publishRuns();
    for (const runId of retained) subscribeRun(runId);
    ctx.sessions.revalidateAutomaticSelection();
  }

  async function refetchTurns(): Promise<boolean> {
    const sessionId = ctx.get().currentSessionId;
    if (!sessionId) return false;
    const seq = (ctx.internals.snapshotRequestSeq.get(sessionId) ?? 0) + 1;
    ctx.internals.snapshotRequestSeq.set(sessionId, seq);
    const known = new Set(
      [...runs.values()].filter((r) => r.sessionId === sessionId).map((r) => r.runId),
    );
    const snapshot = await ctx.client.listTurns(sessionId, REPLAY_LIMIT);
    if (ctx.get().currentSessionId !== sessionId) return false;
    if ((ctx.internals.snapshotAppliedSeq.get(sessionId) ?? 0) >= seq) return false;
    ctx.internals.snapshotAppliedSeq.set(sessionId, seq);
    synchronizeSnapshot(sessionId, snapshot, known);
    return true;
  }

  async function stopRun(runId: string) {
    const run = runs.get(runId);
    if (!run || run.stopPending || run.cancelRequested) return;
    run.stopPending = true;
    publishRuns();
    try {
      const result = await ctx.client.cancelRun(runId);
      if (result.run_id !== runId) throw new Error('stop response run mismatch');
      if (result.status === 'already_settled') {
        await refetchTurns().catch(() => undefined);
        return;
      }
      run.cancelRequested = true;
      applyRunView(run);
      // Stop is not a transport abort: the stream stays until the cancelled terminal arrives.
    } catch (cause) {
      ctx.set({
        refreshFailed: false,
        error:
          cause instanceof ApiError
            ? plainError(cause, '停止没有成功，稍后再试。')
            : '停止没有成功，稍后再试。',
      });
    } finally {
      const current = runs.get(runId);
      if (current) current.stopPending = false;
      publishRuns();
    }
  }

  function reconnectRun(runId: string) {
    const run = runs.get(runId);
    if (!run) return;
    run.connectionError = undefined;
    const replyId = copilotRunReplyMessageId(runId);
    ctx.updateMessages((previous) =>
      previous.map((m) => (m.id === replyId ? { ...m, streaming: true } : m)),
    );
    subscribeRun(runId);
    publishRuns();
  }

  return { trackAccepted, detachSubscriptions, refetchTurns, stopRun, reconnectRun };
}
