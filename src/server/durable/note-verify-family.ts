// DBOS family adapter for note_verify (YUK-1355 receipt reference).
//
// Explicit migration candidate — NOT admitted runtime: nothing in src/ or
// scripts/ imports this module. Serial registration, workflow launch, queue
// admission, phase/fence machinery and shutdown remain parent-owned shared
// lifecycle (see docs/planning/2026-10-11-yuk1355-receipt-reference.md).
// Until the parent registers and proves it, note_verify keeps running on
// pg-boss via src/capabilities/notes/jobs/note_verify.ts.
//
// No-repurchase contract: the paid execution boundary runs inside a single
// named step with retriesAllowed:false. A recovered workflow re-enters
// runNoteVerify, whose reservation prelude refuses to re-purchase a claim in
// provider_started (busy → skipped:in_progress) or result_ready (finalize
// only) — an unknown paid outcome is never auto-replayed as a new provider
// call; backend-specific disposition of skipped:in_progress / ambiguous stays
// with the host (pg-boss handler throws retry-required today; a DBOS host
// decides its own policy), so this adapter only passes results through.
import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';
import { z } from 'zod';

import {
  type RunNoteVerifyResult,
  type RunTaskFn,
  runNoteVerify,
} from '@/capabilities/notes/server/note-verify-durable-operation';
import type { Db } from '@/db/client';

export const NOTE_VERIFY_FAMILY = 'note_verify';
export const NOTE_VERIFY_STEP_NAME = 'note-verify-v1';
/** Same shape as the already-queued pg-boss payload (NoteVerifyJobData). */
export const noteVerifyWorkflowInputSchema = z.object({ artifact_id: z.string().min(1) });
export type NoteVerifyWorkflowInput = z.infer<typeof noteVerifyWorkflowInputSchema>;

export type NoteVerifyRunStepFn = <T>(
  fn: () => Promise<T>,
  config?: StepConfig & { name?: string },
) => Promise<T>;

export type NoteVerifyDurableDeps = {
  db: Db;
  /** Injected by the future parent-owned host; never defaulted here. */
  runTaskFn: RunTaskFn;
};

/**
 * Pure workflow body: durable identity check, payload validation against the
 * queued contract, then the verification operation inside one pinned,
 * non-retryable step. Kept DBOS-free so the wiring contract is testable
 * offline; registerNoteVerifyWorkflow is the real consumer.
 */
export async function runNoteVerifyWorkflowBody(
  deps: NoteVerifyDurableDeps,
  runStep: NoteVerifyRunStepFn,
  workflowId: string | undefined,
  rawInput: unknown,
): Promise<RunNoteVerifyResult> {
  if (!workflowId) throw new Error('note_verify requires a durable workflow identity');
  const payload = noteVerifyWorkflowInputSchema.parse(rawInput);
  return runStep(
    () =>
      runNoteVerify({ db: deps.db, artifactId: payload.artifact_id, runTaskFn: deps.runTaskFn }),
    { name: NOTE_VERIFY_STEP_NAME, retriesAllowed: false },
  );
}

/** Migration-candidate registration entry; the parent-owned host calls this. */
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
