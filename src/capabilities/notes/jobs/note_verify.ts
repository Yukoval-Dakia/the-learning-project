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
import type { Db, Tx } from '@/db/client';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import {
  admitPaidEffectDeliveryControl,
  isPaidEffectControlUndefinedTable,
} from '@/server/durable/paid-effect-control';
import { buildNoteVerificationControlAdmission } from '@/server/durable/paid-effect-note-admission';
import {
  type PaidEffectControlAdmission,
  PaidEffectControlFencedError,
  type PaidEffectControlSnapshot,
} from '@/server/durable/paid-effect-protocol';

// The verification execution itself is backend-agnostic and lives in
// note-verify-durable-operation.ts (YUK-1355 receipt reference). This file
// remains the retained pg-boss consumer: job payload contract, handler
// assembly (runTaskFn default wiring), the retry-visible error mapping, and
// the hub_sync_recovery result floor. The re-export keeps the historical
// import surface (tests, manifest) stable.
//
// YUK-1355 paid-effect control: every pg-boss delivery is admitted through the
// shared backend control BEFORE any claim/provider work. The literal is
// duplicated (not imported from durable/note-verify-family.ts) so the pg-boss
// worker never transitively imports the DBOS SDK; an offline test pins the two
// literals equal. note_verification_claim stays the paid authority for notes —
// this integration is control-only and writes no paid_effect rows.
export const NOTE_VERIFY_PAID_EFFECT_FAMILY = 'note_verify';

const BOOTSTRAP_CONTROL: PaidEffectControlSnapshot = {
  family: NOTE_VERIFY_PAID_EFFECT_FAMILY,
  backend: 'pg-boss',
  generation: 0,
  explicit: false,
};

/**
 * Admit one pg-boss note_verify delivery under backend control. When the
 * control table does not exist yet (parent migration not applied), the
 * bootstrap default stands: pg-boss owns generation 0, so the delivery is
 * admitted and behavior is byte-identical to pre-protocol. Any other error
 * propagates.
 */
export async function admitNoteVerifyDelivery(
  db: Db,
  deliveryId: string,
): Promise<PaidEffectControlAdmission> {
  try {
    return await db.transaction((tx) =>
      admitPaidEffectDeliveryControl(tx, NOTE_VERIFY_PAID_EFFECT_FAMILY, {
        backend: 'pg-boss',
        deliveryId,
      }),
    );
  } catch (error) {
    if (isPaidEffectControlUndefinedTable(error)) {
      return { kind: 'admitted', control: BOOTSTRAP_CONTROL };
    }
    throw error;
  }
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
  /** Test seam for the backend-control admission; production supplies none. */
  admitDelivery?: (deliveryId: string) => Promise<PaidEffectControlAdmission>;
  /**
   * Test seam for the in-transaction admission hook wired into the claim
   * reservation; production supplies none (default: shared control lock +
   * owner/generation check inside the reservation transaction).
   */
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
        // P1-3: a fenced delivery must NOT be silently consumed — the accepted
        // job and its unverified artifact stay visible. Throw so pg-boss
        // redelivers and ultimately routes the job to the DLQ where an
        // operator sees the family ownership conflict; the other backend owns
        // the work, and the claim/effect CAS still protects the paid boundary.
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
