// DBOS family adapter for note_verify. Explicit migration candidate: no runtime
// path imports it, and registration, launch, queue admission and shutdown remain
// parent-owned. Note verification keeps running on pg-boss until the parent
// proves and registers this path.
//
// No repurchase: the paid boundary is one named step with retriesAllowed:false.
// A recovered workflow re-enters runNoteVerify, whose reservation prelude
// refuses to buy again for provider_started (skipped:in_progress) or result_ready
// (finalize only). The host still decides how to dispose of skipped or ambiguous
// outcomes; this adapter only passes results through.
//
// The body admits backend control (dbos, deliveryId = workflowId) before any
// step. Fenced, including a missing control table, means zero paid work: DBOS
// never default-admits. note_verification_claim remains the paid authority.
import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';
import { z } from 'zod';

import {
  type RunNoteVerifyResult,
  type RunTaskFn,
  buildNoteVerificationControlAdmission,
  runNoteVerify,
} from '@/capabilities/notes/public';
import type {
  PaidEffectControlAdmission,
  PaidEffectDeliveryRef,
} from '@/core/migration/paid-effect-protocol';
import { PaidEffectControlFencedError } from '@/core/migration/paid-effect-protocol';
import type { Db } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
  paidEffectControlTableExists,
} from '@/db/paid-effect-control';

export const NOTE_VERIFY_FAMILY = 'note_verify';
export const NOTE_VERIFY_STEP_NAME = 'note-verify-v1';
/** Matches the queued pg-boss payload. */
export const noteVerifyWorkflowInputSchema = z.object({ artifact_id: z.string().min(1) });
export type NoteVerifyWorkflowInput = z.infer<typeof noteVerifyWorkflowInputSchema>;

export type NoteVerifyRunStepFn = <T>(
  fn: () => Promise<T>,
  config?: StepConfig & { name?: string },
) => Promise<T>;

export type NoteVerifyAdmitDeliveryControlFn = (
  db: Db,
  ref: PaidEffectDeliveryRef,
) => Promise<PaidEffectControlAdmission>;

export type NoteVerifyDurableDeps = {
  db: Db;
  /** Injected by the future parent-owned host; never defaulted here. */
  runTaskFn: RunTaskFn;
  /** Backend-control admission; defaults to the shared paid-effect control gate. */
  admitDeliveryControl?: NoteVerifyAdmitDeliveryControlFn;
  /**
   * In-transaction admission hook for the claim reservation. Defaults to the
   * shared DBOS builder; an explicit control row also requires the dispatch
   * generation, so generation-less hosts stay refused.
   */
  buildControlAdmission?: (workflowId: string) => (tx: import('@/db/client').Tx) => Promise<void>;
};

/** Admit under shared backend control; never default-admits. */
export async function defaultAdmitNoteVerifyDeliveryControl(
  db: Db,
  ref: PaidEffectDeliveryRef,
): Promise<PaidEffectControlAdmission> {
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, NOTE_VERIFY_FAMILY);
    // Missing table means the bootstrap pg-boss owner, so fence this delivery.
    // to_regclass, never a caught 42P01.
    if (!(await paidEffectControlTableExists(tx))) {
      return {
        kind: 'fenced',
        reason: 'backend_mismatch',
        owner: 'pg-boss',
        generation: 0,
      };
    }
    return admitPaidEffectDeliveryControl(tx, NOTE_VERIFY_FAMILY, ref);
  });
}

/**
 * DBOS-free workflow body: identity, payload, backend admission, then one
 * non-retryable verification step. registerNoteVerifyWorkflow is the consumer.
 */
export async function runNoteVerifyWorkflowBody(
  deps: NoteVerifyDurableDeps,
  runStep: NoteVerifyRunStepFn,
  workflowId: string | undefined,
  rawInput: unknown,
): Promise<RunNoteVerifyResult> {
  if (!workflowId) throw new Error('note_verify requires a durable workflow identity');
  const payload = noteVerifyWorkflowInputSchema.parse(rawInput);
  const admission = await (deps.admitDeliveryControl ?? defaultAdmitNoteVerifyDeliveryControl)(
    deps.db,
    { backend: 'dbos', deliveryId: workflowId },
  );
  if (admission.kind === 'fenced') {
    throw new PaidEffectControlFencedError(NOTE_VERIFY_FAMILY, admission.reason, admission.owner);
  }
  const controlAdmission = (
    deps.buildControlAdmission ??
    ((workflowId: string) =>
      buildNoteVerificationControlAdmission({ backend: 'dbos', deliveryId: workflowId }))
  )(workflowId);
  return runStep(
    () =>
      runNoteVerify({
        db: deps.db,
        artifactId: payload.artifact_id,
        runTaskFn: deps.runTaskFn,
        controlAdmission,
      }),
    { name: NOTE_VERIFY_STEP_NAME, retriesAllowed: false },
  );
}

/** Migration-candidate registration entry, called by the parent-owned host. */
export function registerNoteVerifyWorkflow(deps: NoteVerifyDurableDeps) {
  return DBOS.registerWorkflow(
    async (rawInput: unknown): Promise<RunNoteVerifyResult> =>
      runNoteVerifyWorkflowBody(
        deps,
        (fn, config) => DBOS.runStep(fn, config),
        DBOS.workflowID,
        rawInput,
      ),
    { name: NOTE_VERIFY_FAMILY },
  );
}
