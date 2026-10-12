import { ENGINEERING_SCHEDULE } from './model';
import { type Due, type EpochMs, EpochMsSchema, type Known, type SkillId } from './types';

export type ScheduleConstraints = Readonly<{
  lastCompletedAt: Known<EpochMs>;
  explicitUserNotBefore: Known<EpochMs>;
}>;
export type Arrangement =
  | {
      kind: 'eligible';
      eligibleAt: EpochMs;
      policyVersion: string;
      appliedConstraints: readonly ('cooldown' | 'user_not_before')[];
    }
  | { kind: 'invalid_input'; reason: string };
function constrain(asOf: EpochMs, base: EpochMs, constraints: ScheduleConstraints): Arrangement {
  if (!EpochMsSchema.safeParse(asOf).success || !EpochMsSchema.safeParse(base).success)
    return { kind: 'invalid_input', reason: 'invalid_time' };
  let at = Math.max(asOf, base);
  const applied: ('cooldown' | 'user_not_before')[] = [];
  if (constraints.lastCompletedAt.kind === 'known') {
    const last = constraints.lastCompletedAt.value;
    const next = EpochMsSchema.safeParse(last + ENGINEERING_SCHEDULE.cooldownMs);
    if (
      !EpochMsSchema.safeParse(last).success ||
      last > asOf ||
      !next.success ||
      !Number.isSafeInteger(asOf - last)
    )
      return { kind: 'invalid_input', reason: 'invalid_time' };
    at = Math.max(at, next.data);
    applied.push('cooldown');
  }
  if (constraints.explicitUserNotBefore.kind === 'known') {
    const notBefore = constraints.explicitUserNotBefore.value;
    if (!EpochMsSchema.safeParse(notBefore).success)
      return { kind: 'invalid_input', reason: 'invalid_time' };
    at = Math.max(at, notBefore);
    applied.push('user_not_before');
  }
  return {
    kind: 'eligible',
    eligibleAt: EpochMsSchema.parse(at),
    policyVersion: ENGINEERING_SCHEDULE.version,
    appliedConstraints: applied,
  };
}
// Callable even when no model or memory state can be decoded.
export function fallbackSchedule(input: {
  asOf: EpochMs;
  constraints: ScheduleConstraints;
}): Arrangement {
  return constrain(input.asOf, input.asOf, input.constraints);
}
export function arrange(input: {
  asOf: EpochMs;
  modelDue: Due;
  constraints: ScheduleConstraints;
}): Arrangement & { modelDue: Due } {
  const d = input.modelDue;
  const base =
    d.kind === 'scheduled' || d.kind === 'due_now'
      ? d.at
      : d.kind === 'beyond_horizon'
        ? d.checkedThrough
        : input.asOf;
  return { ...constrain(input.asOf, base, input.constraints), modelDue: d };
}
export function sortSchedules<T extends { skillId: SkillId; eligibleAt: EpochMs }>(
  items: readonly T[],
): T[] {
  return items.toSorted(
    (a, b) =>
      a.eligibleAt - b.eligibleAt || (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0),
  );
}

export type UserCorrection = Readonly<{
  correctionId: string;
  assertion: 'can_do' | 'cannot_do';
  evidenceRefs: readonly string[];
  notBefore: Known<EpochMs>;
}>;
// The effective correction is selected by the caller. Later weak evidence cannot clear it.
export function applyUserCorrection(input: {
  correction: UserCorrection;
  asOf: EpochMs;
  constraints: ScheduleConstraints;
  conflictingEvidenceRefs: readonly string[];
}): Readonly<{
  correction: UserCorrection;
  displayAssertion: UserCorrection['assertion'];
  optionalCheck: Arrangement;
  conflictingEvidenceRefs: readonly string[];
  source: 'user_correction';
}> {
  const explicit = input.constraints.explicitUserNotBefore;
  const stated = input.correction.notBefore;
  const notBefore =
    explicit.kind === 'known' && stated.kind === 'known'
      ? {
          kind: 'known' as const,
          value: EpochMsSchema.parse(Math.max(explicit.value, stated.value)),
        }
      : stated.kind === 'known'
        ? stated
        : explicit;
  return {
    correction: input.correction,
    displayAssertion: input.correction.assertion,
    optionalCheck: fallbackSchedule({
      asOf: input.asOf,
      constraints: { ...input.constraints, explicitUserNotBefore: notBefore },
    }),
    conflictingEvidenceRefs: [...input.conflictingEvidenceRefs],
    source: 'user_correction',
  };
}
