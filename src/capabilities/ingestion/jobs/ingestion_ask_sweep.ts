import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  listExpiredOpenAsks,
  listPendingResumeSessions,
  listStaleRunningSessions,
  resolveAskByTimeout,
} from '../server/agent/asks';
import { enqueueAgentResume } from '../server/agent/dispatch';
import { STALE_SEGMENT_MS } from '../server/agent/ledger';
import { writeAgentRunSegment } from '../server/events/agent-progress';

// YUK-1522 (R8) — ask sweeper (fast queue, every minute).
//
//   1. Expired open asks resolve honestly as {kind:'skipped', by:'timeout'}
//      (durable ask.resolved + session-stream ask_resolved in one tx), then the
//      session's run is resumed so it can withhold-or-continue.
//   2. `resume_requested` markers with no later `running` segment get
//      re-dispatched — the durable backstop for post-commit enqueue failures.
//   3. A 'running' segment left open past the segment lifetime (worker died
//      mid-model, or post-model bookkeeping crashed — bookkeeping is
//      deliberately never retried as a paid re-run) gets closed 'failed' and
//      the run re-dispatched from the ledger.
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
    const sessions = await listPendingResumeSessions(db, 25);
    for (const sessionId of sessions) {
      await enqueueAgentResume(sessionId).catch((err) =>
        console.error('[ingestion-ask-sweep] resume dispatch failed', { sessionId, error: err }),
      );
    }
    const stale = await listStaleRunningSessions(db, STALE_SEGMENT_MS, 10);
    for (const entry of stale) {
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
