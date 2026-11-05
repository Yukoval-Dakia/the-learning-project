// Bounded attempts inside one durable batch. A lost worker never resumes this loop.
import { eq } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import { boundTerminalHttpStatus, providerTransientVerdict } from '@/ai/provider-failure';
import type { ProviderTransportEvidence, TaskTextResult } from '@/ai/task-result';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import {
  planProviderTransientRetry,
  providerTransientRetryPolicy,
  sleepMs,
} from '@/server/ai/provider-transient-retry';

export class AdmissionAttemptExhausted extends Error {
  constructor(
    message: string,
    readonly taskRunIds: string[],
  ) {
    super(message);
  }
}

/** A completed response failed the capability's structured contract. */
export class AdmissionParseFailure extends Error {}

// The final root response must be observed, not inferred from an error string.
export function admissionHttpFailureStatus(
  error: AgentRunError,
  transport?: ProviderTransportEvidence,
): number | null {
  return boundTerminalHttpStatus(error, transport);
}

/**
 * Invoke the durable stage and validate its result. Provider-transient
 * failures (bound 429/5xx, bad gateway, positive not_sent) re-issue inside one
 * configured bound — `rate_limited` consumes the provider's retry_after and the
 * retry count/wait ceiling; the other classes keep the ADR-0079 single extra
 * send. `sent_without_response`, unsettled or unknown outcomes always throw
 * through — resending them could double-bill.
 */
export async function runAdmissionAttempts<T>(
  db: Db,
  invoke: () => Promise<TaskTextResult>,
  validate: (result: TaskTextResult) => Promise<T>,
): Promise<{ value: T; taskRunIds: string[] }> {
  const ids: string[] = [];
  const policy = providerTransientRetryPolicy();
  const retryBudget = { retries: 0, waitedMs: 0 };
  for (;;) {
    try {
      const result = await invoke();
      if (result.task_run_id) ids.push(result.task_run_id);
      return { value: await validate(result), taskRunIds: ids };
    } catch (error) {
      if (error instanceof AdmissionParseFailure) {
        const runId = ids.at(-1);
        const [row] = runId
          ? await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, runId))
          : [];
        if (row?.status !== 'success' || !row.finished_at)
          throw new Error('Unsealed admission parse failure; paid outcome unknown', {
            cause: error,
          });
        throw new AdmissionAttemptExhausted(error.message, ids);
      }
      if (!(error instanceof AgentRunError)) throw error;
      ids.push(error.taskRunId);
      const [row] = await db
        .select()
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, error.taskRunId));
      const settled = row?.finished_at != null && row.status !== 'running';
      const transport = settled ? row.usage_json.transport : undefined;
      const httpStatus = settled ? admissionHttpFailureStatus(error, transport) : null;
      // No running/unknown attempt, timeout, cancellation, or sent-without-
      // response retry — only positively-evidenced transient classes re-issue.
      const verdict = settled ? providerTransientVerdict({ error, transport }) : undefined;
      if (verdict !== undefined) {
        const plan = await planProviderTransientRetry({
          db,
          error,
          policy,
          budget: retryBudget,
        });
        if (plan !== undefined) {
          retryBudget.retries += 1;
          retryBudget.waitedMs += plan.delayMs;
          if (plan.delayMs > 0) await sleepMs(plan.delayMs);
          continue;
        }
      }
      const knownTerminal =
        settled &&
        (verdict !== undefined ||
          httpStatus != null ||
          error.subtype === 'error_max_structured_output_retries' ||
          error.helpProviderFault?.kind === 'parse');
      if (knownTerminal) throw new AdmissionAttemptExhausted(error.message, ids);
      throw error;
    }
  }
}
