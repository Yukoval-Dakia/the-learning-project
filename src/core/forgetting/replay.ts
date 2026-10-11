import { coldState, evolve } from './engine';
import { modelError, sameVersions } from './model';
import {
  type AppendReceipt,
  AppendReceiptSchema,
  type EffectiveObservation,
  EffectiveObservationSchema,
  type EpochMs,
  EpochMsSchema,
  type Evolution,
  type MemoryModel,
  type MemoryState,
  MemoryStateSchema,
} from './types';

// The caller resolves effective judgments, withdrawals and mapping revisions BEFORE this boundary.
// Digests are caller-owned canonical fact digests, never hashes of computed floating-point output.
export function replay(input: {
  seed: Pick<MemoryState, 'learnerId' | 'skillId' | 'scope' | 'versions' | 'inputDigest'>;
  effective: readonly Readonly<{
    observation: EffectiveObservation;
    recordedSequence: number;
    receipt: AppendReceipt;
  }>[];
  queryTime: EpochMs;
  knowledgeCutoff: number;
  model: MemoryModel;
}): Evolution {
  if (
    !EpochMsSchema.safeParse(input.queryTime).success ||
    !Number.isSafeInteger(input.knowledgeCutoff) ||
    input.knowledgeCutoff < 0
  )
    return { kind: 'invalid', reason: 'invalid_input' };
  for (const e of input.effective) {
    if (
      !EffectiveObservationSchema.safeParse(e.observation).success ||
      !AppendReceiptSchema.safeParse(e.receipt).success ||
      !Number.isSafeInteger(e.recordedSequence) ||
      e.recordedSequence < 0
    )
      return { kind: 'invalid', reason: 'invalid_input' };
  }
  const error = modelError(input.model);
  if (error)
    return { kind: error === 'version_mismatch' ? 'rebuild_required' : 'invalid', reason: error };
  if (!MemoryStateSchema.safeParse(coldState(input.seed)).success)
    return { kind: 'invalid', reason: 'invalid_state' };
  if (!sameVersions(input.seed.versions, input.model.versions))
    return { kind: 'rebuild_required', reason: 'version_mismatch' };
  const selected = input.effective
    .filter(
      (e) =>
        e.observation.occurredAt <= input.queryTime && e.recordedSequence <= input.knowledgeCutoff,
    )
    .toSorted((a, b) =>
      a.observation.orderKey < b.observation.orderKey
        ? -1
        : a.observation.orderKey > b.observation.orderKey
          ? 1
          : 0,
    );
  let state = coldState(input.seed);
  const attempts = new Map<string, { observation: EffectiveObservation; receipt: AppendReceipt }>();
  for (const e of selected) {
    const old = attempts.get(e.observation.attemptId);
    if (old) {
      if (
        JSON.stringify(EffectiveObservationSchema.parse(old.observation)) !==
          JSON.stringify(EffectiveObservationSchema.parse(e.observation)) ||
        JSON.stringify(AppendReceiptSchema.parse(old.receipt)) !==
          JSON.stringify(AppendReceiptSchema.parse(e.receipt))
      )
        return { kind: 'rebuild_required', reason: 'attempt_conflict' };
      continue;
    }
    const result = evolve({
      state,
      observation: e.observation,
      receipt: e.receipt,
      model: input.model,
    });
    if (result.kind !== 'updated' && result.kind !== 'duplicate') return result;
    state = result.state;
    attempts.set(e.observation.attemptId, { observation: e.observation, receipt: e.receipt });
  }
  return { kind: 'updated', state };
}
