// Nightly maintenance producer. Unlike the cheap structured-output jobs, this runs
// the broader tool-calling review task and still writes only inbox proposals.
//
// One model run per subject with failures inside the recent window. Each subject gets
// its own subtree, profile and failure rows: a subject's conventions never leak into
// another's tree, and a quiet subject is never crowded out by a busy one's rows.

import type { Job } from 'pg-boss';
import {
  type MaintenanceReviewPlan,
  type MaintenanceReviewTarget,
  planMaintenanceReview,
  runMaintenanceReview,
} from '@/capabilities/knowledge/server/review';
import type { Db } from '@/db/client';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { planJobProviderWaitForRun, providerWaitOutput } from '@/server/ai/provider-wait';

export interface KnowledgeMaintenanceNightlyResult {
  /** Subject runs the night started (one per subject with failures inside the window). */
  processed: number;
  /** Selectable subjects with nothing new; they cost no model call. */
  skipped_no_failures: number;
  proposals_created: number;
  pending_after: number;
}

export type PlanMaintenanceReviewFn = (db: Db) => Promise<MaintenanceReviewPlan>;
export type RunMaintenanceReviewFn = (ctx: {
  db: Db;
  target: MaintenanceReviewTarget;
}) => Response | Promise<Response>;

interface DepsOverride {
  planFn?: PlanMaintenanceReviewFn;
  runMaintenanceReviewFn?: RunMaintenanceReviewFn;
}

// Failures arrive as an in-band marker in the stream body. Detect it, or a
// timeout/auth failure would look like a successful run with zero proposals.
async function drainResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let acc = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc += decoder.decode(value, { stream: true });
    }
    acc += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return acc;
}

const STREAM_ERROR_MARKER = /\[streamTask\][^\n]*/;
const STREAM_ERROR_RUN_ID = /task_run_id=([^\s)]+)/;

/** The settled run behind a streamTask failure marker, when the marker carried it. */
export class KnowledgeMaintenanceStreamError extends Error {
  constructor(
    message: string,
    readonly taskRunId: string | null,
    readonly subject: string,
  ) {
    super(message);
  }
}

export async function runKnowledgeMaintenanceNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<KnowledgeMaintenanceNightlyResult> {
  const beforeRows = await listProposalInboxRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const plan = await (deps.planFn ?? planMaintenanceReview)(db);
  const run = deps.runMaintenanceReviewFn ?? runMaintenanceReview;

  // Sequential on purpose: one subject's model run finishes before the next starts, so
  // a failure stays attributable to its subject and two runs never race the same inbox gate.
  // A failing subject does not abort the loop: one broken subject must not starve the rest.
  const failures: KnowledgeMaintenanceStreamError[] = [];
  let thrown: unknown = null;
  for (const target of plan.targets) {
    try {
      const body = await drainResponseText(await run({ db, target }));
      const match = body.match(STREAM_ERROR_MARKER);
      if (!match) continue;
      const error = new KnowledgeMaintenanceStreamError(
        `knowledge_maintenance_nightly streamTask failure (${target.subject}): ${match[0].trim()}`,
        body.match(STREAM_ERROR_RUN_ID)?.[1] ?? null,
        target.subject,
      );
      console.error(`[knowledge_maintenance_nightly] subject run failed: ${target.subject}`, error);
      failures.push(error);
    } catch (err) {
      console.error(`[knowledge_maintenance_nightly] subject run threw: ${target.subject}`, err);
      thrown ??= err;
    }
  }

  const afterRows = await listProposalInboxRows(db);
  // A failed subject still fails the night. Subject selection is a plain recent-failures
  // window, so the retry this triggers is what keeps the subject from falling out of it.
  // Proposals the healthy subjects already wrote survive: the retry re-runs them, and the
  // inbox cooldown gate refuses their duplicates.
  const failure = failures.find((error) => error.taskRunId !== null) ?? failures[0] ?? thrown;
  if (failure) throw failure;

  return {
    processed: plan.targets.length,
    skipped_no_failures: plan.skipped_subjects.length,
    proposals_created: afterRows.filter((row) => !beforeIds.has(row.id)).length,
    pending_after: afterRows.filter((row) => row.status === 'pending').length,
  };
}

export function buildKnowledgeMaintenanceNightlyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<Record<string, never>>[]) => Promise<Record<string, unknown> | undefined> {
  return async () => {
    try {
      const result = await runKnowledgeMaintenanceNightly(db, deps);
      console.log('[knowledge_maintenance_nightly] result', result);
      return { ...result };
    } catch (err) {
      // Provable transient provider rejection → ask the DAG for a recovery wait.
      if (err instanceof KnowledgeMaintenanceStreamError && err.taskRunId) {
        const wait = await planJobProviderWaitForRun(db, err.taskRunId, {
          errorEvidence: [err.message],
        });
        if (wait) {
          return providerWaitOutput({
            retryClass: wait.retryClass,
            detail: `evidence=${wait.evidenceRef}`,
          });
        }
      }
      console.error('[knowledge_maintenance_nightly] failed', err);
      throw err;
    }
  };
}
