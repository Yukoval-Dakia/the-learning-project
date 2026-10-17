import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  listExpiredOpenAsks,
  listPendingResumeSessions,
  resolveAskByTimeout,
} from '../server/agent/asks';
import { enqueueAgentResume } from '../server/agent/dispatch';

// YUK-1522 (R8) — ask sweeper (fast queue, every minute).
//
//   1. Expired open asks resolve honestly as {kind:'skipped', by:'timeout'}
//      (durable ask.resolved + session-stream ask_resolved in one tx), then the
//      session's run is resumed so it can withhold-or-continue.
//   2. `resume_requested` markers with no later `running` segment get
//      re-dispatched — the durable backstop for post-commit enqueue failures.
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
  };
}
