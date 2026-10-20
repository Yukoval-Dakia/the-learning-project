import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  listExpiredOpenAsks,
  listPendingContinuationSessions,
  listPendingResumeSessions,
  listStaleRunningSessions,
  resolveAskByTimeout,
} from '../server/agent/asks';
import { enqueueAgentContinuation, enqueueAgentResume } from '../server/agent/dispatch';
import { STALE_SEGMENT_MS } from '../server/agent/ledger';
import { failSessionForUnknownPaidAttempt } from '../server/agent/run';

// YUK-1522 (R8) — ask sweeper (fast queue, every minute).
//
//   1. Expired open asks resolve honestly as {kind:'skipped', by:'timeout'}
//      (durable ask.resolved + session-stream ask_resolved in one tx), then the
//      session's run is resumed so it can withhold-or-continue.
//   2. `resume_requested` markers with no later `running` segment get
//      re-dispatched — the durable backstop for post-commit enqueue failures.
//   3. `continue_requested` markers (written in the same tx as an early_exit
//      close) get re-dispatched with a deterministic job id — a lost
//      continuation send can never wedge the session (R2-4).
//   4. A 'running' segment left open past the segment lifetime (worker died
//      mid-model, or post-model bookkeeping crashed — bookkeeping is
//      deliberately never retried as a paid re-run):
//      or an old failed segment whose session settlement never committed:
//      close session/receipt/grant/operation atomically, without entering the
//      model. A missing paid marker is not unsent proof. Execution uncertainty
//      and unknown cost remain blockers until evidenced reconciliation.
//
// First-writer-wins: a learner answer racing the sweep resolves under the same
// per-ask advisory lock, never double-resolves.

export function buildIngestionAskSweepHandler(db: Db) {
  return async (_jobs: Job[]) => {
    const expired = await listExpiredOpenAsks(db, 50);
    for (const askId of expired) {
      await resolveAskByTimeout(db, askId).catch((err) =>
        console.error('[ingestion-ask-sweep] timeout resolution failed', { askId, error: err }),
      );
    }
    const resumes = await listPendingResumeSessions(db, 25);
    for (const entry of resumes) {
      await enqueueAgentResume(entry.session_id, entry.marker_id).catch((err) =>
        console.error('[ingestion-ask-sweep] resume dispatch failed', {
          sessionId: entry.session_id,
          error: err,
        }),
      );
    }
    const continuations = await listPendingContinuationSessions(db, 25);
    for (const entry of continuations) {
      await enqueueAgentContinuation(entry.session_id, entry.marker_id).catch((err) =>
        console.error('[ingestion-ask-sweep] continuation dispatch failed', {
          sessionId: entry.session_id,
          error: err,
        }),
      );
    }
    const stale = await listStaleRunningSessions(db, STALE_SEGMENT_MS, 10);
    for (const entry of stale) {
      await failSessionForUnknownPaidAttempt(db, entry.session_id, entry.segment, {
        markerId: entry.marker_id,
        operationId: entry.operation_id,
        runRef: entry.run_ref,
      }).catch((err) =>
        console.error('[ingestion-ask-sweep] terminal settlement recovery failed', {
          sessionId: entry.session_id,
          segment: entry.segment,
          error: err,
        }),
      );
    }
  };
}
