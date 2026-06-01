// Strategy D Slice B (YUK-190) — observe-only auto-enroll production consumer.
//
// Enqueued by tencent_ocr_extract after a successful extraction (session
// 'extracted'|'partial'). Runs runAutoEnrollForSession, which with the enroll
// flag OFF + observe ON (the default) runs TaggingTask + WorkflowJudge per draft
// block and writes one durable `experimental:auto_enroll_observed` audit event
// per block — zero domain rows, every block stays 'draft'. See
// docs/superpowers/specs/2026-06-01-stratD-sliceB-auto-enroll-wiring-design.md.
//
// Failure boundary (§5): per-block tagging/judge/observe-write faults are
// swallowed INSIDE the runner (missing XIAOMI_API_KEY → TaggingTaskError →
// route-to-review; a single failed audit write logs + continues). So this
// handler-level catch does NOT guard the missing-key path. It guards only a
// genuinely-escaping fault: a non-TaggingTaskError that the runner re-raises
// (e.g. DB connection lost). We re-throw such faults so pg-boss retries on this
// queue alone — never the expensive OCR job, never the session status.

import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { runAutoEnrollForSession } from '@/server/ingestion/auto-enroll';

export interface AutoEnrollJobData {
  sessionId: string;
}

export function buildAutoEnrollHandler(db: Db): (jobs: Job<AutoEnrollJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const sessionId = job.data?.sessionId;
      if (!sessionId) {
        console.warn('[auto_enroll] job missing sessionId', job.id);
        continue;
      }
      try {
        const result = await runAutoEnrollForSession({ db, sessionId, ctx: { db } });
        console.log(
          `[auto_enroll] ${sessionId} → ${result.status} (enrolled=${result.enrolled}, routed_to_review=${result.routed_to_review})`,
        );
      } catch (err) {
        // A genuinely-escaping fault (per-block AI/missing-key/observe-write are
        // already swallowed upstream). Re-throw so pg-boss retries this cheap
        // tagging job in isolation — extraction + session status are untouched.
        console.error(`[auto_enroll] ${sessionId} failed`, err);
        throw err;
      }
    }
  };
}
