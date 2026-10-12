import { retrievabilityForKc as legacyRetention } from '@/core/fsrs';
import {
  type RetentionReading,
  type SchedulingState,
  isCandidateState,
} from '@/core/schema/scheduling-state';
import { candidateRetention } from './candidate';
import { selectedForgettingEngine } from './engine-selection';

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
