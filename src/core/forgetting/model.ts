import { FractionSchema, type MemoryModel, VersionSchema, type Versions } from './types';

export const DAY_MS = 86_400_000;
export const VERSIONS: Versions = Object.freeze({
  model: VersionSchema.parse('history-kernel-logistic-v1'),
  parameters: VersionSchema.parse('engineering-20261011-v1'),
  mapping: VersionSchema.parse('evidence-quality-20261011-v2'),
  order: VersionSchema.parse('effective-order-lexicographic-v1'),
});
// All thirteen numeric constants are engineering assumptions, not fitted population priors.
export const ENGINEERING_MODEL: MemoryModel = Object.freeze({
  versions: VERSIONS,
  provenance: 'engineering',
  fastHalfLifeDays: 1,
  slowHalfLifeDays: 14,
  fastWeight: FractionSchema.parse(0.75),
  gain: 4,
  failureRate: Math.LN2,
  spacingDays: 1,
});
export const ENGINEERING_MAPPING = Object.freeze({
  provenance: 'engineering',
  calibration: 'uncalibrated',
  interval: 'not_estimated',
  shallowHelp: 0.5,
  deepHelp: 0.25,
  answerExposure: 0.1,
  guessed: 0.25,
  guessUnknown: 0.5,
  lowConfidence: 0.5,
  contextPseudoCount: 4,
  selfReport: 0.1,
});
// Scheduling values are separate engineering assumptions, not retention probability targets.
export const ENGINEERING_SCHEDULE = Object.freeze({
  version: 'memory-schedule-20261011-v1',
  provenance: 'engineering',
  targetScore: 0.6,
  horizonDays: 365,
  toleranceMs: 1_000,
  cooldownMs: DAY_MS,
});
export function sameVersions(a: Versions, b: Versions): boolean {
  return (
    a.model === b.model &&
    a.parameters === b.parameters &&
    a.mapping === b.mapping &&
    a.order === b.order
  );
}
export function modelError(model: MemoryModel): string | null {
  if (!model?.versions || !sameVersions(model.versions, VERSIONS)) return 'version_mismatch';
  if (model.provenance !== 'engineering') return 'invalid_model';
  for (const key of [
    'fastHalfLifeDays',
    'slowHalfLifeDays',
    'fastWeight',
    'gain',
    'failureRate',
    'spacingDays',
  ] as const) {
    if (!Number.isFinite(model[key]) || model[key] !== ENGINEERING_MODEL[key])
      return 'invalid_model';
  }
  return null;
}
