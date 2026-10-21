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
import { buildNoteVerificationControlAdmission } from '@/capabilities/notes/server/paid-effect-note-admission';
import {
  type PaidEffectControlAdmission,
  PaidEffectControlFencedError,
  type PaidEffectControlSnapshot,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
  paidEffectControlTableExists,
} from '@/db/paid-effect-control';
import { makeRunTaskFn } from '@/server/ai/runner-fn';

// Retained pg-boss consumer. The verification execution is backend-agnostic in
// note-verify-durable-operation.ts; this file owns the job payload, handler
// wiring, retry-visible errors, and the recovery result floor.
//
// Backend control admits every delivery before any claim or provider work. The
// family literal is duplicated (rather than imported from the DBOS adapter) so
// this worker never pulls in the DBOS SDK; note_verification_claim remains the
// paid authority.
export const NOTE_VERIFY_PAID_EFFECT_FAMILY = 'note_verify';

const BOOTSTRAP_CONTROL: PaidEffectControlSnapshot = {
  family: NOTE_VERIFY_PAID_EFFECT_FAMILY,
  backend: 'pg-boss',
  generation: 0,
  explicit: false,
};

/**
 * Admit one delivery under backend control. Before the parent migration exists,
 * pg-boss owns generation 0 and the delivery is admitted. The missing-table
 * check probes with to_regclass inside the transaction because a caught 42P01
 * would abort it.
 */
export async function admitNoteVerifyDelivery(
  db: Db,
  deliveryId: string,
): Promise<PaidEffectControlAdmission> {
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, NOTE_VERIFY_PAID_EFFECT_FAMILY);
    if (!(await paidEffectControlTableExists(tx))) {
      return { kind: 'admitted', control: BOOTSTRAP_CONTROL };
    }
    return admitPaidEffectDeliveryControl(tx, NOTE_VERIFY_PAID_EFFECT_FAMILY, {
      backend: 'pg-boss',
      deliveryId,
    });
  });
}

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
  /** Test seam for delivery admission; production supplies none. */
  admitDelivery?: (deliveryId: string) => Promise<PaidEffectControlAdmission>;
  /** Test seam for the reservation-transaction admission hook. */
  buildControlAdmission?: (deliveryId: string) => (tx: Tx) => Promise<void>;
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
  const admitDelivery =
    deps.admitDelivery ?? ((deliveryId: string) => admitNoteVerifyDelivery(db, deliveryId));
  const buildControlAdmission =
    deps.buildControlAdmission ??
    ((deliveryId: string) =>
      buildNoteVerificationControlAdmission({ backend: 'pg-boss', deliveryId }));
  return async (jobs) => {
    for (const job of jobs) {
      const artifactId = job.data?.artifact_id;
      if (!artifactId) {
        console.warn('[note_verify] job missing artifact_id', job.id);
        continue;
      }
      const admission = await admitDelivery(job.id);
      if (admission.kind === 'fenced') {
        // A fenced delivery must not be acknowledged: throwing keeps the job and
        // the unverified artifact visible and eventually lands it in the DLQ for
        // an operator, while the claim CAS still guards the paid boundary.
        throw new PaidEffectControlFencedError(
          NOTE_VERIFY_PAID_EFFECT_FAMILY,
          admission.reason,
          admission.owner,
        );
      }
      const result = await runNoteVerify({
        db,
        artifactId,
        runTaskFn,
        controlAdmission: buildControlAdmission(job.id),
      });
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
