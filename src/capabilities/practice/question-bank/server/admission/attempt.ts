// Bounded attempts inside one durable batch. A lost worker never resumes this loop.
import { eq } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import type { TaskTextResult } from '@/ai/task-result';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';

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

export async function runAdmissionAttempts<T>(
  db: Db,
  invoke: () => Promise<TaskTextResult>,
  validate: (result: TaskTextResult) => Promise<T>,
): Promise<{ value: T; taskRunIds: string[] }> {
  const ids: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
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
        if (attempt === 0) continue;
        throw new AdmissionAttemptExhausted(error.message, ids);
      }
      if (!(error instanceof AgentRunError)) throw error;
      ids.push(error.taskRunId);
      const [row] = await db
        .select()
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, error.taskRunId));
      // No running/unknown attempt, timeout, cancellation, lease loss, or quota retry.
      // Connection retry requires positive transport evidence that nothing was sent.
      const retryable =
        row?.finished_at != null &&
        row.status !== 'running' &&
        (row.usage_json.transport?.send_state === 'not_sent' ||
          error.subtype === 'error_max_structured_output_retries' ||
          error.helpProviderFault?.kind === 'parse' ||
          error.helpProviderFault?.kind === 'bad_gateway' ||
          (error.subtype === 'api_error_result' &&
            error.apiErrorStatus != null &&
            error.apiErrorStatus >= 500));
      if (retryable && attempt === 0) continue;
      const knownTerminal =
        row?.finished_at != null &&
        (retryable || (error.subtype === 'api_error_result' && error.apiErrorStatus != null));
      if (knownTerminal) throw new AdmissionAttemptExhausted(error.message, ids);
      throw error;
    }
  }
  throw new Error('Unreachable admission attempt');
}
