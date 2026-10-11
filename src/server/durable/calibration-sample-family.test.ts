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
  runCalibrationSampleTick,
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
const request = { source: { kind: 'dbos', workflowId, scheduledAt } } as const;

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

describe('gate-only calibration candidate', () => {
  // @invariant security: a workflow cannot evaluate a different scheduled tick
  // @fails-if remove the identity check; a mismatched workflow reaches the gate
  it('rejects mismatched identity before evaluating the gate', async () => {
    const { operation } = port(true);
    await expect(
      runCalibrationSampleTick(
        {
          source: { ...request.source, workflowId: 'foreign-workflow' },
        },
        { operation },
      ),
    ).rejects.toThrow('Native identity');
    expect(operation.readGate).not.toHaveBeenCalled();
  });

  // @invariant data: disabled sampling cannot start a paid batch
  // @fails-if route a disabled tick to paid execution; the sentinel batch throws
  it('disabled ticks execute no paid work', async () => {
    const { operation, runPaidBatch } = port(false);
    expect(await runCalibrationSampleTick(request, { operation })).toEqual({
      family: CALIBRATION_SAMPLE_FAMILY,
      tick: { workflowId, scheduledAt },
      outcome: { kind: 'disabled', flagEnv: null },
    });
    expect(runPaidBatch).not.toHaveBeenCalled();
  });

  // @invariant data: repeated enabled invocations stay held without a durable claim
  // @fails-if add an authorized path; a repeat invocation can start another paid batch
  it('holds every enabled invocation without any paid execution', async () => {
    const { operation, runPaidBatch } = port(true);
    for (let invocation = 0; invocation < 2; invocation += 1) {
      expect(await runCalibrationSampleTick(request, { operation })).toEqual({
        family: CALIBRATION_SAMPLE_FAMILY,
        tick: { workflowId, scheduledAt },
        outcome: { kind: 'held', reason: CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE },
      });
    }
    expect(runPaidBatch).not.toHaveBeenCalled();
  });

  // @invariant data: a dead second lane cannot trigger paid fallback work
  // @fails-if catch the gate failure and run a fallback; the rejection disappears
  it('propagates gate failure without running a paid fallback', async () => {
    const { operation, runPaidBatch } = port(true);
    const failure = new Error('missing second-lane credentials');
    operation.readGate.mockRejectedValue(failure);
    await expect(runCalibrationSampleTick(request, { operation })).rejects.toBe(failure);
    expect(runPaidBatch).not.toHaveBeenCalled();
  });
});

describe('DBOS wrapper with offline SDK doubles', () => {
  // @invariant data: a held business obligation cannot be reported as workflow success
  // @fails-if return the held record from the workflow; the rejection assertion fails
  it('throws the admission prerequisite for an enabled tick', async () => {
    const { operation, runPaidBatch } = port(true);
    const workflow = registerCalibrationSampleWorkflow(db, { operation });
    await expect(workflow(scheduledAt, {})).rejects.toMatchObject({
      name: 'CalibrationSampleAdmissionRequiredError',
      record: {
        tick: { workflowId, scheduledAt },
        outcome: { kind: 'held', reason: CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE },
      },
    });
    expect(runPaidBatch).not.toHaveBeenCalled();
  });

  // @invariant concurrency: replay uses the saved step result even when its body is skipped
  // @fails-if assign a workflow-local variable inside the step; cached replay loses the result
  it('returns a cached disabled result without re-running the step body', async () => {
    const saved: CalibrationSampleTickRecord = {
      family: CALIBRATION_SAMPLE_FAMILY,
      tick: { workflowId, scheduledAt },
      outcome: { kind: 'disabled', flagEnv: 'false' },
    };
    vi.mocked(DBOS.runStep).mockResolvedValueOnce(undefined).mockResolvedValueOnce(saved);
    const { operation, runPaidBatch } = port(true);
    const workflow = registerCalibrationSampleWorkflow(db, { operation });
    expect(await workflow(scheduledAt, {})).toBe(saved);
    expect(operation.readGate).not.toHaveBeenCalled();
    expect(runPaidBatch).not.toHaveBeenCalled();
  });

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

  // @invariant data: an epoch fence stops evaluation before any batch can start
  // @fails-if bypass the epoch step; the workflow evaluates the gate after a fence error
  it('propagates the epoch fence without evaluating the gate', async () => {
    const failure = new Error('epoch fenced');
    vi.mocked(waitForRunnableEpoch).mockRejectedValue(failure);
    const { operation, runPaidBatch } = port(true);
    const workflow = registerCalibrationSampleWorkflow(db, { operation });
    await expect(workflow(scheduledAt, {})).rejects.toBe(failure);
    expect(operation.readGate).not.toHaveBeenCalled();
    expect(runPaidBatch).not.toHaveBeenCalled();
  });
});
