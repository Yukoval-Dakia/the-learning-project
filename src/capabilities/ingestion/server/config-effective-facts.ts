// YUK-1007 — ingestion 拥有键的 consumer-effective 事实（真实 reader 调用，
// 不复述 clamp 规则）。经 ingestion/public.ts 透出给组合根 facts seam。
import type { ConfigEffectiveFacts } from '@/core/config/effective';
import { autoEnrollThreshold } from './workflow-judge-config';

export function ingestionConfigEffectiveFacts(): ConfigEffectiveFacts {
  return {
    WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: { value: autoEnrollThreshold() },
  };
}
