// Consumer-effective facts for ingestion-owned config keys, read through the real
// readers rather than restating clamp rules. Exposed via ingestion/public.ts.
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { autoEnrollThreshold } from './workflow-judge-config';

export function ingestionConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: { value: autoEnrollThreshold() },
  };
}
