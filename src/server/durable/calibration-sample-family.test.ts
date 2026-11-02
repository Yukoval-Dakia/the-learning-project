import { DBOS } from '@dbos-inc/dbos-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { waitForRunnableEpoch } from '@/server/contract-epoch';
import {
  CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE,
  CALIBRATION_SAMPLE_FAMILY,
  CalibrationSampleAdmissionRequiredError,
  type CalibrationSampleOperationPort,
  type CalibrationSampleTickRecord,
  calibrationSampleScheduledId,
  registerCalibrationSampleWorkflow,
} from './calibration-sample-family';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/server/contract-epoch', () => ({ waitForRunnableEpoch: vi.fn(async () => {}) }));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    workflowID: 'sched-judge_calibration_sample-2026-10-11T22:10:00.000Z',
    registerWorkflow: vi.fn((fn: unknown) => fn),
    runStep: vi.fn(),
  },
}));

const scheduledAt = new Date('2026-10-11T22:10:00.000Z');
const workflowId = calibrationSampleScheduledId(scheduledAt);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(DBOS.runStep)
    .mockReset()
    .mockImplementation(async (fn) => fn());
  vi.mocked(waitForRunnableEpoch).mockReset().mockResolvedValue(undefined);
});

function port(enabled: boolean) {
  const runPaidBatch = vi.fn(async () => {
    throw new Error('candidate must not execute paid work');
  });
  const operation = {
    readGate: vi.fn(async () =>
      enabled ? { kind: 'enabled' as const } : { kind: 'disabled' as const, flagEnv: undefined },
    ),
    runPaidBatch,
  } satisfies CalibrationSampleOperationPort & { runPaidBatch: typeof runPaidBatch };
  return { operation, runPaidBatch };
}

describe('DBOS wrapper with offline SDK doubles', () => {
  // Gate outcomes (disabled no-spend, held prerequisite, bare gate-failure
  // propagation) are proven on real Postgres by
  // calibration-sample-durable-operation.db.test.ts; this file keeps only the
  // DBOS SDK replay semantics that the DB lane cannot reach.

  // @invariant concurrency: a replayed held result remains an unresolved obligation
  // @fails-if the wrapper treats cached step success as business completion; it resolves
  it('throws for a cached held result without executing paid work', async () => {
    const saved: CalibrationSampleTickRecord = {
      family: CALIBRATION_SAMPLE_FAMILY,
      tick: { workflowId, scheduledAt },
      outcome: { kind: 'held', reason: CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE },
    };
    vi.mocked(DBOS.runStep).mockResolvedValueOnce(undefined).mockResolvedValueOnce(saved);
    const { operation, runPaidBatch } = port(false);
    const workflow = registerCalibrationSampleWorkflow(db, { operation });
    await expect(workflow(scheduledAt, {})).rejects.toBeInstanceOf(
      CalibrationSampleAdmissionRequiredError,
    );
    expect(operation.readGate).not.toHaveBeenCalled();
    expect(runPaidBatch).not.toHaveBeenCalled();
  });
});
