// YUK-1355: unregistered, gate-only DBOS candidate. There is no durable
// calibration pre-spend claim, so this module has no paid execution port.
// Registration, scheduling, business receipts and admission remain parent-owned.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { waitForRunnableEpoch } from '@/server/contract-epoch';

export const CALIBRATION_SAMPLE_FAMILY = 'judge_calibration_sample';
export const CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE =
  'judge_calibration_sample DBOS admission requires a durable pre-spend claim and outcome reconciliation; see docs/planning/2026-10-11-yuk1355-timed-reference.md';

export function calibrationSampleScheduledId(scheduledAt: Date): string {
  return `sched-${CALIBRATION_SAMPLE_FAMILY}-${scheduledAt.toISOString()}`;
}

export const calibrationSampleRequestSchema = z.strictObject({
  source: z
    .strictObject({
      kind: z.literal('dbos'),
      workflowId: z.string().min(1),
      scheduledAt: z.date(),
    })
    .superRefine((source, ctx) => {
      if (source.workflowId !== calibrationSampleScheduledId(source.scheduledAt)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Native identity must equal the exact scheduled ID',
        });
      }
    }),
});
export type CalibrationSampleTickId = Omit<
  z.infer<typeof calibrationSampleRequestSchema>['source'],
  'kind'
>;

// Implemented structurally in the capability. No server-to-capability import,
// mirrored config/count types, opaque dependencies or paid authorization hook.
export interface CalibrationSampleOperationPort {
  readGate(): Promise<{ kind: 'disabled'; flagEnv: string | undefined } | { kind: 'enabled' }>;
}

export type CalibrationSampleTickRecord = {
  family: typeof CALIBRATION_SAMPLE_FAMILY;
  tick: CalibrationSampleTickId;
  outcome:
    | { kind: 'disabled'; flagEnv: string | null }
    | { kind: 'held'; reason: typeof CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE };
};

/** Gate evaluation only. An enabled tick stays held on every invocation. */
export async function runCalibrationSampleTick(
  request: z.input<typeof calibrationSampleRequestSchema>,
  deps: { operation: CalibrationSampleOperationPort },
): Promise<CalibrationSampleTickRecord> {
  const { source } = calibrationSampleRequestSchema.parse(request);
  const tick = { workflowId: source.workflowId, scheduledAt: source.scheduledAt };
  const gate = await deps.operation.readGate();
  return {
    family: CALIBRATION_SAMPLE_FAMILY,
    tick,
    outcome:
      gate.kind === 'disabled'
        ? { kind: 'disabled', flagEnv: gate.flagEnv ?? null }
        : { kind: 'held', reason: CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE },
  };
}

export class CalibrationSampleAdmissionRequiredError extends Error {
  constructor(readonly record: CalibrationSampleTickRecord) {
    super(CALIBRATION_SAMPLE_ADMISSION_PREREQUISITE);
    this.name = 'CalibrationSampleAdmissionRequiredError';
  }
}

export const CALIBRATION_SAMPLE_STEP_EPOCH_GATE = 'calibration-epoch-gate-v1';
export const CALIBRATION_SAMPLE_STEP_ADMISSION_GATE = 'calibration-admission-gate-v1';

/**
 * No caller registers this candidate. Completed steps return their saved value
 * on replay; workflow code must use that return value, never a step-local write.
 * retriesAllowed:false disables exception retries, not crash-step replay.
 * maxRecoveryAttempts:1 is not a paid safety guarantee. This workflow cannot pay.
 */
export function registerCalibrationSampleWorkflow(
  db: Db,
  opts: { operation: CalibrationSampleOperationPort },
) {
  return DBOS.registerWorkflow(
    async (scheduledDate: Date, _context: unknown): Promise<CalibrationSampleTickRecord> => {
      const workflowId = DBOS.workflowID;
      if (!workflowId) throw new Error('Calibration sample requires a durable workflow identity');
      const request = calibrationSampleRequestSchema.parse({
        source: { kind: 'dbos', workflowId, scheduledAt: scheduledDate },
      });
      await DBOS.runStep(() => waitForRunnableEpoch(db), {
        name: CALIBRATION_SAMPLE_STEP_EPOCH_GATE,
        retriesAllowed: false,
      });
      const record = await DBOS.runStep(() => runCalibrationSampleTick(request, opts), {
        name: CALIBRATION_SAMPLE_STEP_ADMISSION_GATE,
        retriesAllowed: false,
      });
      // A held business obligation must not become workflow SUCCESS.
      if (record.outcome.kind === 'held') throw new CalibrationSampleAdmissionRequiredError(record);
      // A disabled workflow result is diagnostic, not a discharge receipt.
      return record;
    },
    { name: CALIBRATION_SAMPLE_FAMILY, maxRecoveryAttempts: 1 },
  );
}
