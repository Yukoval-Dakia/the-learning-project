import { createHash } from 'node:crypto';

export const ATTRIBUTION_FOLLOWUP_QUEUE = 'attribution_followup' as const;
export const VARIANT_GEN_QUEUE = 'variant_gen' as const;

export type FailureLearningQueue = typeof ATTRIBUTION_FOLLOWUP_QUEUE | typeof VARIANT_GEN_QUEUE;

/** Stable RFC 9562 UUIDv8 for one attempt and one versioned workflow stage. */
export function failureLearningJobId(queue: FailureLearningQueue, attemptEventId: string): string {
  const hex = createHash('sha256')
    .update(`practice.failure-learning@v1\0${queue}\0${attemptEventId}`)
    .digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16);
  const value = bytes.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}
