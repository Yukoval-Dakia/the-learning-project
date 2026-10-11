import type { StepConfig } from '@dbos-inc/dbos-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { NoteVerifyJobData } from '@/capabilities/notes/jobs/note_verify';
import type { RunNoteVerifyResult } from '@/capabilities/notes/server/note-verify-durable-operation';
import type { Db } from '@/db/client';

import {
  NOTE_VERIFY_FAMILY,
  NOTE_VERIFY_STEP_NAME,
  type NoteVerifyRunStepFn,
  noteVerifyWorkflowInputSchema,
  runNoteVerifyWorkflowBody,
} from './note-verify-family';
import type { PaidEffectControlAdmission } from './paid-effect-protocol';

const admittedControl: PaidEffectControlAdmission = {
  kind: 'admitted',
  control: { family: NOTE_VERIFY_FAMILY, backend: 'pg-boss', generation: 0, explicit: false },
};

const wiringDeps = {
  db: {} as Db,
  runTaskFn: async () => {
    throw new Error('runTaskFn must not run in wiring tests');
  },
  admitDeliveryControl: async () => admittedControl,
};

function stubDb(reservation: unknown): Db {
  return {
    transaction: async () => reservation,
  } as unknown as Db;
}

describe('note-verify DBOS family adapter wiring', () => {
  // @invariant concurrency: a durable execution must be pinned to a durable workflow identity before any step runs, so DBOS replay can deduplicate recoveries
  // @fails-if the body executes its step without a workflowID, letting every recovery run a fresh unpinned execution of the paid boundary
  it('refuses to execute without a durable workflow identity', async () => {
    const runStep = vi.fn();
    await expect(
      runNoteVerifyWorkflowBody(wiringDeps, runStep as never, undefined, { artifact_id: 'a1' }),
    ).rejects.toThrow('durable workflow identity');
    expect(runStep).not.toHaveBeenCalled();
  });

  // @invariant data: the durable input and family name are exactly the pg-boss producer identity, so already-queued note_verify payloads stay consumable after any cutover
  // @fails-if the schema accepts a renamed or optional field (artifactId, empty artifact_id) or the family name drifts from the note_verify queue
  it('accepts exactly the already-queued note_verify payload and family name', () => {
    expect(NOTE_VERIFY_FAMILY).toBe('note_verify');
    const queuedPayload: NoteVerifyJobData = { artifact_id: 'a1' };
    expect(noteVerifyWorkflowInputSchema.parse(queuedPayload)).toEqual({ artifact_id: 'a1' });
    expect(noteVerifyWorkflowInputSchema.safeParse({ artifactId: 'a1' }).success).toBe(false);
    expect(noteVerifyWorkflowInputSchema.safeParse({ artifact_id: '' }).success).toBe(false);
    expect(noteVerifyWorkflowInputSchema.safeParse({}).success).toBe(false);
  });

  // @invariant concurrency: the paid verification boundary runs inside one pinned non-retryable step, so step recovery can never freely re-execute the provider call
  // @fails-if retriesAllowed becomes true or the step name is generated per run, letting a DBOS step replay re-cross the paid boundary
  it('runs the operation in a pinned non-retryable step and returns the recorded result unchanged', async () => {
    const recorded: RunNoteVerifyResult = { status: 'verified', artifact_type: 'note_atomic' };
    let capturedConfig: { name?: string; retriesAllowed?: boolean } | undefined;
    const replayingRunStep: NoteVerifyRunStepFn = async <T>(
      _fn: () => Promise<T>,
      config?: StepConfig & { name?: string },
    ) => {
      capturedConfig = config;
      return recorded as T;
    };
    const result = await runNoteVerifyWorkflowBody(wiringDeps, replayingRunStep, 'wf-1', {
      artifact_id: 'a1',
    });
    expect(capturedConfig).toEqual({ name: NOTE_VERIFY_STEP_NAME, retriesAllowed: false });
    expect(NOTE_VERIFY_STEP_NAME).toBe('note-verify-v1');
    expect(result).toBe(recorded);
  });

  // @invariant concurrency: a delivery fenced by backend control never enters the paid step — the workflow errors before any provider work, and DBOS never default-admits
  // @fails-if a fenced delivery still runs the step (paid work under the wrong owner) or the admission error is swallowed into a SUCCESS result
  it('throws PaidEffectControlFencedError before the step when admission is fenced', async () => {
    const runStep = vi.fn();
    const fencedDeps = {
      ...wiringDeps,
      admitDeliveryControl: async () =>
        ({ kind: 'fenced', reason: 'backend_mismatch', owner: 'pg-boss', generation: 0 }) as const,
    };
    await expect(
      runNoteVerifyWorkflowBody(fencedDeps, runStep as never, 'wf-fenced', { artifact_id: 'a1' }),
    ).rejects.toThrow('fenced');
    expect(runStep).not.toHaveBeenCalled();
  });

  // @invariant data: the workflow body returns the operation's status union unchanged so the host can disposition every skip reason
  // @fails-if the body maps, filters, or swallows operation statuses, hiding skip reasons from the owning backend's disposition policy
  it('passes the operation result through without mapping or swallowing statuses', async () => {
    const db = stubDb({ kind: 'not_found' });
    const runTaskFn = vi.fn(wiringDeps.runTaskFn);
    const executingRunStep: NoteVerifyRunStepFn = async (fn, config) => {
      expect(config?.retriesAllowed).toBe(false);
      return fn();
    };
    await expect(
      runNoteVerifyWorkflowBody({ db, runTaskFn }, executingRunStep, 'wf-2', {
        artifact_id: 'missing',
      }),
    ).resolves.toEqual({ status: 'skipped:not_found' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});
