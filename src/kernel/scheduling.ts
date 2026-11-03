// Forgetting-engine selection and the retention reading every scheduling reader shares.
import { z } from 'zod';
import { retrievabilityForKc as legacyRetention } from '@/core/fsrs';
import { candidateRetention } from '@/core/scheduling/candidate';
import {
  type RetentionReading,
  type SchedulingState,
  isCandidateState,
} from '@/core/schema/scheduling-state';

const EngineSelection = z.enum(['fsrs', 'forgetting_candidate']);
/** FSRS stays the default until the candidate engine passes its separate acceptance gate. */
export function selectedForgettingEngine() {
  return EngineSelection.parse(process.env.FORGETTING_ENGINE ?? 'fsrs');
}

export type { RetentionReading } from '@/core/schema/scheduling-state';
export function retrievabilityForKc(state: SchedulingState | null, now: Date): RetentionReading {
  if (state && isCandidateState(state))
    return {
      ...candidateRetention(state, now).now,
      calibration: 'uncalibrated',
      provenance: 'engineering',
    };
  if (selectedForgettingEngine() === 'forgetting_candidate')
    return {
      kind: 'unknown',
      reason: state ? 'legacy_conversion_required' : 'missing_state',
      calibration: 'uncalibrated',
      provenance: 'engineering',
    };
  return legacyRetention(state, now);
}
