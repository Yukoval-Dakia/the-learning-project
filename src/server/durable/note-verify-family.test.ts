import { describe, expect, it, vi } from 'vitest';

import type { PaidEffectControlAdmission } from '@/core/migration/paid-effect-protocol';
import type { Db } from '@/db/client';
import { NOTE_VERIFY_FAMILY, runNoteVerifyWorkflowBody } from './note-verify-family';

// The workflow body's DBOS wiring identity pin is the only contract this file
// still proves offline. Step pinning, admission fencing and passthrough are
// covered at the pg-boss handler boundary by note_verify.control.test.ts and
// against real claims by note-verify-durable-operation.db.test.ts.
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
});
