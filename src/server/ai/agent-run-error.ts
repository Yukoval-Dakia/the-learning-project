// Server adapters for the shared single-attempt failure contract.
// Admission retains its runtime class identity; SDK result shapes stay here.

import { AgentRunError } from '@/ai/agent-run-error';
import type { SealedHelpLatency } from '@/ai/help-latency';
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
  helpLatency?: SealedHelpLatency;
}): AgentRunError {
  if (input.error instanceof AgentRunError) {
    if (input.costUsd === undefined && input.helpLatency === undefined) return input.error;
    return new AgentRunError({
      kind: input.error.kind,
      taskRunId: input.error.taskRunId,
      subtype: input.error.subtype,
      ...(input.error.apiErrorStatus !== undefined
        ? { apiErrorStatus: input.error.apiErrorStatus }
        : {}),
      errors: input.error.errors,
      ...((input.costUsd ?? input.error.costUsd) !== undefined
        ? { costUsd: input.costUsd ?? input.error.costUsd }
        : {}),
      ...(input.error.helpProviderFault
        ? { helpProviderFault: input.error.helpProviderFault }
        : {}),
      ...((input.helpLatency ?? input.error.helpLatency)
        ? { helpLatency: input.helpLatency ?? input.error.helpLatency }
        : {}),
    });
  }
  if (input.error instanceof ProviderSessionAdmissionError) {
    return new AgentRunError({
      kind: input.kind,
      taskRunId: input.taskRunId,
      subtype: 'provider_admission',
      errors: [input.error.message],
      ...(input.helpLatency ? { helpLatency: input.helpLatency } : {}),
    });
  }
  return new AgentRunError({
    kind: input.kind,
    taskRunId: input.taskRunId,
    costUsd: input.costUsd,
    subtype: input.aborted ? 'budget_timeout' : 'runner_error',
    errors: [input.error instanceof Error ? input.error.message : String(input.error)],
    ...(input.helpLatency ? { helpLatency: input.helpLatency } : {}),
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
