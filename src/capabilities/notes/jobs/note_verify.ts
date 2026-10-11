import type { Job } from 'pg-boss';

import {
  type BossDispatch,
  dispatchNoteVerificationClaimRecovery,
} from '@/capabilities/notes/server/note-handoff';
import {
  listRecoverableNoteVerificationResults,
  prepareNoteVerificationResultRecovery,
} from '@/capabilities/notes/server/note-verification-claim';
import {
  type RunTaskFn,
  finalizeStagedNoteVerification,
  noteVerificationRetryRequired,
  runNoteVerify,
} from '@/capabilities/notes/server/note-verify-durable-operation';
import type { Db } from '@/db/client';
import { makeRunTaskFn } from '@/server/ai/runner-fn';

// The verification execution itself is backend-agnostic and lives in
// note-verify-durable-operation.ts (YUK-1355 receipt reference). This file
// remains the retained pg-boss consumer: job payload contract, handler
// assembly (runTaskFn default wiring), the retry-visible error mapping, and
// the hub_sync_recovery result floor. The re-export keeps the historical
// import surface (tests, manifest) stable.
export {
  type RunNoteVerifyParams,
  type RunNoteVerifyResult,
  type RunTaskFn,
  noteBodyBlockContractFailure,
  runNoteVerify,
} from '@/capabilities/notes/server/note-verify-durable-operation';

export interface NoteVerifyJobData {
  artifact_id: string;
}

type DepsOverride = {
  runTaskFn?: RunTaskFn;
  onPassed?: (artifactId: string) => Promise<void>;
};

export async function recoverResultReadyNoteVerifications(
  db: Db,
  deps: { readonly boss?: BossDispatch } = {},
): Promise<number> {
  const artifactIds = await listRecoverableNoteVerificationResults(db);
  let finalized = 0;
  const errors: unknown[] = [];
  for (const artifactId of artifactIds) {
    try {
      const prepared = await prepareNoteVerificationResultRecovery(db, artifactId);
      if (!prepared) continue;
      if (prepared.kind === 'retry_required') {
        await dispatchNoteVerificationClaimRecovery(prepared.artifactId, prepared.fence, deps);
        continue;
      }
      const result = await finalizeStagedNoteVerification(db, artifactId, prepared.artifactType);
      if (result.status === 'verified' || result.status === 'needs_review') finalized += 1;
    } catch (error) {
      console.error('[note_verify] result recovery deferred', artifactId, error);
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'note verification recovery batch failed');
  }
  return finalized;
}

export function buildNoteVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<NoteVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_verify] job missing artifact_id', job.id);
        continue;
      }
      const result = await runNoteVerify({ db, artifactId, runTaskFn });
      if (result.status === 'skipped:in_progress' || result.status === 'skipped:ambiguous') {
        throw noteVerificationRetryRequired(artifactId, result.status);
      }
      if (result.status === 'verified' && result.artifact_type === 'note_atomic') {
        await deps.onPassed?.(artifactId);
      }
      console.log(`[note_verify] ${artifactId} -> ${result.status}`);
    }
  };
}
