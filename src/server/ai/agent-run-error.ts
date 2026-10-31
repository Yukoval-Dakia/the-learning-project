// Server adapters for the shared single-attempt failure contract.
// Admission retains its runtime class identity; SDK result shapes stay here.

import { AgentRunError } from '@/ai/agent-run-error';
import { ProviderSessionAdmissionError } from './provider-session-admission-policy';
import type { SDKMessage } from './sdk-types';

/**
 * Preserve the durable attempt identity for every exception escaping a started
 * lifecycle, not only terminal errors: unknown exceptions stay permanent, but
 * budget/provenance code can still consume the persisted attempt id.
 */
export function bindAgentRunError(input: {
  error: unknown;
  kind: string;
  taskRunId: string;
  aborted: boolean;
  costUsd?: number;
}): AgentRunError {
  if (input.error instanceof AgentRunError) {
    return input.costUsd === undefined
      ? input.error
      : new AgentRunError({ ...input.error, costUsd: input.costUsd });
  }
  if (input.error instanceof ProviderSessionAdmissionError) {
    return new AgentRunError({
      kind: input.kind,
      taskRunId: input.taskRunId,
      subtype: 'provider_admission',
      errors: [input.error.message],
    });
  }
  return new AgentRunError({
    kind: input.kind,
    taskRunId: input.taskRunId,
    costUsd: input.costUsd,
    subtype: input.aborted ? 'budget_timeout' : 'runner_error',
    errors: [input.error instanceof Error ? input.error.message : String(input.error)],
  });
}

/** Narrow runner predicate: does this terminal result carry the success+is_error
 *  API-error shape? One predicate for classification and the breadcrumb. */
export function isApiErrorSuccessResult(
  msg: Extract<SDKMessage, { type: 'result' }>,
): msg is Extract<SDKMessage, { type: 'result'; subtype: 'success' }> & {
  is_error: true;
  api_error_status?: number | null;
} {
  return msg.subtype === 'success' && 'is_error' in msg && msg.is_error === true;
}
