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
import { writeAgentRunSegment } from '../server/events/agent-progress';

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
//        - NO agent.paid_attempt 'sent' marker → the model call never
//          dispatched; close the segment 'failed' + resume safely.
//        - 'sent' marker present → the provider outcome is unknown; NEVER
//          re-pay. Emit error{worker_lost, retryable:true} + session failed so
//          the owner retries explicitly through the failed→agent path (R2-5).
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
    for (const sessionId of resumes) {
      await enqueueAgentResume(sessionId).catch((err) =>
        console.error('[ingestion-ask-sweep] resume dispatch failed', { sessionId, error: err }),
      );
    }
    const continuations = await listPendingContinuationSessions(db, 25);
    for (const sessionId of continuations) {
      await enqueueAgentContinuation(sessionId).catch((err) =>
        console.error('[ingestion-ask-sweep] continuation dispatch failed', {
          sessionId,
          error: err,
        }),
      );
    }
    const stale = await listStaleRunningSessions(db, STALE_SEGMENT_MS, 10);
    for (const entry of stale) {
      if (entry.paid_attempt_sent) {
        // Unknown paid outcome / lost bookkeeping — never re-pay silently.
        await failSessionForUnknownPaidAttempt(db, entry.session_id, entry.segment).catch((err) =>
          console.error('[ingestion-ask-sweep] stale paid-attempt terminal write failed', {
            sessionId: entry.session_id,
            segment: entry.segment,
            error: err,
          }),
        );
        continue;
      }
      await db
        .transaction(async (tx) => {
          await writeAgentRunSegment(tx, entry.session_id, {
            segment: entry.segment,
            trigger: 'resume',
            outcome: 'failed',
          });
          await writeAgentRunSegment(tx, entry.session_id, {
            segment: 0,
            trigger: 'resume',
            outcome: 'resume_requested',
          });
        })
        .catch((err) =>
          console.error('[ingestion-ask-sweep] stale segment close failed', {
            sessionId: entry.session_id,
            segment: entry.segment,
            error: err,
          }),
        );
      await enqueueAgentResume(entry.session_id).catch((err) =>
        console.error('[ingestion-ask-sweep] stale resume dispatch failed', {
          sessionId: entry.session_id,
          error: err,
        }),
      );
    }
  };
}
