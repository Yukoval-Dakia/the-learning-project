import {
  DAY_MS,
  ENGINEERING_MAPPING,
  ENGINEERING_SCHEDULE,
  VERSIONS,
  modelError,
  sameVersions,
} from './model';
import {
  type AppendReceipt,
  AppendReceiptSchema,
  type Due,
  type EffectiveObservation,
  EffectiveObservationSchema,
  type EpochMs,
  EpochMsSchema,
  type Evolution,
  type Known,
  type MemoryModel,
  type MemoryState,
  MemoryStateSchema,
  type MemoryView,
  MemoryViewSchema,
  type RetentionPoint,
  ScoreSchema,
  type Versions,
  VersionsSchema,
} from './types';

export function coldState(
  input: Pick<MemoryState, 'learnerId' | 'skillId' | 'scope' | 'versions' | 'inputDigest'>,
): MemoryState {
  return {
    ...input,
    schemaVersion: 'memory-kernel-state-v1',
    through: { kind: 'unknown', reason: 'no_effective_events' },
    lastApplied: { kind: 'unknown', reason: 'no_effective_events' },
    projection: { kind: 'cold' },
  };
}
function observationBytes(o: EffectiveObservation): string {
  return JSON.stringify([
    o.learnerId,
    o.skillId,
    o.attemptId,
    o.effectiveJudgmentId,
    o.context.kind === 'known' ? ['known', o.context.value] : ['unknown', o.context.reason],
    o.occurredAt,
    o.orderKey,
    o.evidenceDigest,
    o.quality,
    o.weight,
    o.independent,
    o.evidenceRefs,
    o.mappingNotes,
  ]);
}
function stateError(state: MemoryState, model: MemoryModel): string | null {
  if (!state) return 'missing_state';
  if (state.schemaVersion !== 'memory-kernel-state-v1') return 'version_mismatch';
  if (!MemoryStateSchema.safeParse(state).success) return 'invalid_state';
  if (!sameVersions(state.versions, model.versions)) return 'version_mismatch';
  if (state.projection.kind === 'cold') {
    return state.through.kind === 'unknown' && state.lastApplied.kind === 'unknown'
      ? null
      : 'incomplete_projection';
  }
  if (state.through.kind !== 'known' || state.lastApplied.kind !== 'known')
    return 'incomplete_projection';
  const o = state.lastApplied.value;
  if (
    o.orderKey !== state.through.value ||
    o.occurredAt !== state.projection.lastAt ||
    o.learnerId !== state.learnerId ||
    o.skillId !== state.skillId ||
    !matchesScope(state, o)
  )
    return 'incomplete_projection';
  if (!Number.isFinite(state.projection.fast + state.projection.slow)) return 'numeric_range';
  return null;
}
function matchesScope(state: MemoryState, o: EffectiveObservation): boolean {
  return (
    state.scope.kind === 'global' ||
    (o.context.kind === 'known' && o.context.value === state.scope.key)
  );
}
export function evolve(input: {
  state: MemoryState;
  observation: EffectiveObservation;
  receipt: AppendReceipt;
  model: MemoryModel;
}): Evolution {
  const { state, observation: o, receipt, model } = input;
  const error = modelError(model);
  if (error)
    return { kind: error === 'version_mismatch' ? 'rebuild_required' : 'invalid', reason: error };
  const invalidState = stateError(state, model);
  if (invalidState)
    return {
      kind: invalidState === 'version_mismatch' ? 'rebuild_required' : 'invalid',
      reason: invalidState,
    };
  if (
    !EffectiveObservationSchema.safeParse(o).success ||
    !AppendReceiptSchema.safeParse(receipt).success ||
    receipt.nextThrough !== o.orderKey
  )
    return { kind: 'invalid', reason: 'invalid_input' };
  if (state.learnerId !== o.learnerId || state.skillId !== o.skillId || !matchesScope(state, o))
    return { kind: 'invalid', reason: 'scope_mismatch' };
  if (receipt.nextInputDigest === state.inputDigest) {
    if (
      state.through.kind === 'known' &&
      state.through.value === receipt.nextThrough &&
      state.lastApplied.kind === 'known' &&
      observationBytes(state.lastApplied.value) === observationBytes(o)
    )
      return { kind: 'duplicate', state };
    return { kind: 'rebuild_required', reason: 'conflict' };
  }
  if (receipt.previousInputDigest !== state.inputDigest)
    return { kind: 'rebuild_required', reason: 'digest_mismatch' };
  if (state.through.kind === 'known' && o.orderKey <= state.through.value)
    return { kind: 'rebuild_required', reason: 'old_order_key' };
  if (state.lastApplied.kind === 'known' && state.lastApplied.value.attemptId === o.attemptId)
    return { kind: 'rebuild_required', reason: 'attempt_conflict' };
  const p = state.projection;
  const deltaMs = p.kind === 'cold' ? 0 : o.occurredAt - p.lastAt;
  if (!Number.isSafeInteger(deltaMs) || deltaMs < 0)
    return { kind: 'invalid', reason: 'invalid_time' };
  const delta = deltaMs / DAY_MS;
  const spacing = p.kind === 'cold' ? 1 : -Math.expm1(-delta / model.spacingDays);
  const penalty = Math.exp(-model.failureRate * o.weight * (1 - o.quality));
  const gain = model.gain * o.weight * o.quality * spacing;
  const fast =
    (p.kind === 'cold' ? 0 : p.fast * Math.exp((-Math.LN2 * delta) / model.fastHalfLifeDays)) *
      penalty +
    model.fastWeight * gain;
  const slow =
    (p.kind === 'cold' ? 0 : p.slow * Math.exp((-Math.LN2 * delta) / model.slowHalfLifeDays)) *
      penalty +
    (1 - model.fastWeight) * gain;
  const eventCount = (p.kind === 'cold' ? 0 : p.eventCount) + 1;
  const independentMass =
    (p.kind === 'cold' ? 0 : p.independentMass) + (o.independent ? o.weight : 0);
  if (
    !Number.isSafeInteger(eventCount) ||
    !Number.isFinite(fast + slow) ||
    independentMass > Number.MAX_SAFE_INTEGER ||
    (p.kind === 'warm' && o.independent && independentMass <= p.independentMass)
  )
    return { kind: 'invalid', reason: 'numeric_range' };
  return {
    kind: 'updated',
    state: {
      ...state,
      inputDigest: receipt.nextInputDigest,
      through: { kind: 'known', value: receipt.nextThrough },
      lastApplied: {
        kind: 'known',
        value: {
          ...o,
          context: { ...o.context },
          evidenceRefs: [...o.evidenceRefs],
          mappingNotes: [...o.mappingNotes],
        },
      },
      projection: { kind: 'warm', eventCount, fast, slow, lastAt: o.occurredAt, independentMass },
    },
  };
}
type Kernels = {
  fast: number;
  slow: number;
  scope: 'global' | 'context_shrunk' | 'global_borrowed';
};
function decayed(
  state: MemoryState,
  at: EpochMs,
  model: MemoryModel,
): Known<{ fast: number; slow: number }> {
  const error = stateError(state, model);
  if (error) return { kind: 'unknown', reason: error };
  const p = state.projection;
  if (p.kind === 'cold') return { kind: 'unknown', reason: 'cold' };
  const deltaMs = at - p.lastAt;
  if (!Number.isSafeInteger(deltaMs) || deltaMs < 0)
    return { kind: 'unknown', reason: 'invalid_time' };
  return {
    kind: 'known',
    value: {
      fast: p.fast * Math.exp((-Math.LN2 * deltaMs) / DAY_MS / model.fastHalfLifeDays),
      slow: p.slow * Math.exp((-Math.LN2 * deltaMs) / DAY_MS / model.slowHalfLifeDays),
    },
  };
}
function kernels(view: MemoryView, at: EpochMs, model: MemoryModel): Known<Kernels> {
  const error = modelError(model);
  if (error) return { kind: 'unknown', reason: error };
  if (!EpochMsSchema.safeParse(at).success) return { kind: 'unknown', reason: 'invalid_time' };
  if (!view?.global) return { kind: 'unknown', reason: 'missing_state' };
  if (!MemoryViewSchema.safeParse(view).success)
    return { kind: 'unknown', reason: 'invalid_state' };
  if (view?.global?.scope?.kind !== 'global') return { kind: 'unknown', reason: 'scope_mismatch' };
  if (view.context.kind === 'known') {
    const c = view.context.value;
    if (
      view.requestedScope.kind !== 'context' ||
      c.scope.kind !== 'context' ||
      c.scope.key !== view.requestedScope.key ||
      c.learnerId !== view.global.learnerId ||
      c.skillId !== view.global.skillId ||
      !sameVersions(c.versions, view.global.versions)
    )
      return { kind: 'unknown', reason: 'scope_mismatch' };
  }
  const global = decayed(view.global, at, model);
  if (global.kind === 'unknown') return global;
  if (view.requestedScope.kind === 'global')
    return { kind: 'known', value: { ...global.value, scope: 'global' } };
  if (view.context.kind === 'unknown')
    return { kind: 'known', value: { ...global.value, scope: 'global_borrowed' } };
  const c = view.context.value;
  const context = decayed(c, at, model);
  if (context.kind === 'unknown') return context;
  const n = c.projection.kind === 'warm' ? c.projection.independentMass : 0;
  const lambda = n / (n + ENGINEERING_MAPPING.contextPseudoCount);
  return {
    kind: 'known',
    value: {
      fast: (1 - lambda) * global.value.fast + lambda * context.value.fast,
      slow: (1 - lambda) * global.value.slow + lambda * context.value.slow,
      scope: 'context_shrunk',
    },
  };
}
function score(mass: number) {
  return ScoreSchema.parse(mass / (1 + mass));
}
function point(view: MemoryView, asOf: EpochMs, model: MemoryModel): RetentionPoint {
  const k = kernels(view, asOf, model);
  if (k.kind === 'unknown') return { kind: 'unknown', asOf, reason: k.reason };
  const mass = k.value.fast + k.value.slow;
  if (!Number.isFinite(mass)) return { kind: 'unknown', asOf, reason: 'numeric_range' };
  return {
    kind: 'score',
    asOf,
    value: score(mass),
    calibration: 'uncalibrated',
    interval: 'not_estimated',
    scope: k.value.scope,
  };
}
export function retention(input: {
  view: MemoryView;
  asOf: EpochMs;
  offsetsDays: readonly number[];
  model: MemoryModel;
}): Readonly<{
  versions: Versions;
  inputDigests: readonly MemoryState['inputDigest'][];
  now: RetentionPoint;
  future: readonly RetentionPoint[];
}> {
  const { view, asOf, offsetsDays, model } = input;
  const now = point(view, asOf, model);
  return {
    versions: VersionsSchema.safeParse(model?.versions).success ? model.versions : VERSIONS,
    inputDigests: MemoryViewSchema.safeParse(view).success
      ? view.context.kind === 'known'
        ? [view.global.inputDigest, view.context.value.inputDigest]
        : [view.global.inputDigest]
      : [],
    now,
    future: offsetsDays.map((offset) => {
      const at = EpochMsSchema.safeParse(asOf + offset * DAY_MS);
      if (
        !Number.isFinite(offset) ||
        offset < 0 ||
        !at.success ||
        !Number.isSafeInteger(offset * DAY_MS)
      )
        return { kind: 'unknown', asOf, reason: 'invalid_time' };
      // A historical read cannot become valid by moving its requested offsets into the future.
      return now.kind === 'unknown'
        ? { kind: 'unknown', asOf: at.data, reason: now.reason }
        : point(view, at.data, model);
    }),
  };
}
export function due(input: {
  view: MemoryView;
  asOf: EpochMs;
  target: ReturnType<typeof ScoreSchema.parse>;
  horizonAt: EpochMs;
  model: MemoryModel;
}): Due {
  const { view, asOf, target, horizonAt, model } = input;
  if (
    !EpochMsSchema.safeParse(asOf).success ||
    !EpochMsSchema.safeParse(horizonAt).success ||
    !Number.isSafeInteger(horizonAt - asOf) ||
    horizonAt < asOf ||
    !Number.isFinite(target) ||
    target <= 0 ||
    target >= 1
  )
    return { kind: 'invalid_input', reason: 'invalid_input' };
  const k = kernels(view, asOf, model);
  if (k.kind === 'unknown')
    return {
      kind: ['invalid_time', 'invalid_state', 'invalid_model', 'numeric_range'].includes(k.reason)
        ? 'invalid_input'
        : 'unknown',
      reason: k.reason,
    };
  const { fast, slow } = k.value;
  const mass = fast + slow;
  if (!Number.isFinite(mass)) return { kind: 'invalid_input', reason: 'numeric_range' };
  const threshold = target / (1 - target);
  if (mass <= threshold) return { kind: 'due_now', at: asOf, target };
  const span = Math.min(horizonAt - asOf, ENGINEERING_SCHEDULE.horizonDays * DAY_MS);
  const through = EpochMsSchema.safeParse(asOf + span);
  if (!through.success) return { kind: 'invalid_input', reason: 'invalid_time' };
  const atOffset = (ms: number) =>
    fast * Math.exp((-Math.LN2 * ms) / DAY_MS / model.fastHalfLifeDays) +
    slow * Math.exp((-Math.LN2 * ms) / DAY_MS / model.slowHalfLifeDays);
  const atHorizon = atOffset(span);
  if (atHorizon > threshold)
    return { kind: 'beyond_horizon', checkedThrough: through.data, scoreThere: score(atHorizon) };
  const logRatio = Math.log2(mass) - Math.log2(threshold);
  let left = model.fastHalfLifeDays * logRatio * DAY_MS;
  let right = Math.min(span, model.slowHalfLifeDays * logRatio * DAY_MS);
  if (atOffset(left) <= threshold) left = 0;
  if (atOffset(right) > threshold) right = Math.min(span, right + ENGINEERING_SCHEDULE.toleranceMs);
  if (atOffset(left) <= threshold || atOffset(right) > threshold)
    return { kind: 'unknown', reason: 'numeric_bracket' };
  let iterations = 0;
  while (right - left > ENGINEERING_SCHEDULE.toleranceMs && iterations < 64) {
    const mid = left + (right - left) / 2;
    if (atOffset(mid) > threshold) left = mid;
    else right = mid;
    iterations++;
  }
  if (right - left > ENGINEERING_SCHEDULE.toleranceMs)
    return { kind: 'unknown', reason: 'solver_limit' };
  const result = EpochMsSchema.safeParse(Math.ceil(asOf + right));
  if (!result.success) return { kind: 'invalid_input', reason: 'invalid_time' };
  if (result.data > through.data || atOffset(result.data - asOf) > threshold)
    return { kind: 'unknown', reason: 'numeric_bracket' };
  return {
    kind: 'scheduled',
    at: result.data,
    target,
    toleranceMs: ENGINEERING_SCHEDULE.toleranceMs,
  };
}
