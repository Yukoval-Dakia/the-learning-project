import { createHash } from 'node:crypto';
import type { CopilotRunInput } from './copilot-run-input';

const deliveredContextDigestBySdkSession = new Map<string, string>();
const MAX_TRACKED_SDK_SESSIONS = 256;

export function copilotSessionContextDigest(input: CopilotRunInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        learner_state_header: input.learner_state_header ?? '',
        proposal_feedback: input.proposal_feedback,
      }),
      'utf8',
    )
    .digest('hex');
}

export function shouldDeliverCopilotSessionContext(sdkSessionId: string, digest: string): boolean {
  return deliveredContextDigestBySdkSession.get(sdkSessionId) !== digest;
}

export function markCopilotSessionContextDelivered(sdkSessionId: string, digest: string): void {
  deliveredContextDigestBySdkSession.delete(sdkSessionId);
  deliveredContextDigestBySdkSession.set(sdkSessionId, digest);
  while (deliveredContextDigestBySdkSession.size > MAX_TRACKED_SDK_SESSIONS) {
    const oldestSessionId = deliveredContextDigestBySdkSession.keys().next().value;
    if (oldestSessionId === undefined) break;
    deliveredContextDigestBySdkSession.delete(oldestSessionId);
  }
}

export function clearCopilotSessionContextDelivery(sdkSessionId: string): void {
  deliveredContextDigestBySdkSession.delete(sdkSessionId);
}
