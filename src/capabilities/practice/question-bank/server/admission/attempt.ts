// Terminal mapping for one durable stage call — the bounded re-send chain
// lives in stages.ts on `call:N:attempt:M`; this layer only turns a settled
// failure into the caller's exhausted outcome.
import { eq } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import { boundTerminalHttpStatus, providerTransientVerdict } from '@/ai/provider-failure';
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

/**
 * Invoke the durable stage once and validate its result. Provider-transient
 * re-issue lives inside the stage's `call:N:attempt:M` chain (stages.ts), where
 * the paid_effect attempt counter is the durable retry bound — a second invoke
 * here would authorize a new call_index and double-pay on replay. This layer
 * only maps a settled terminal failure into the caller's exhausted outcome.
 */
export async function runAdmissionAttempts<T>(
  db: Db,
  invoke: () => Promise<TaskTextResult>,
  validate: (result: TaskTextResult) => Promise<T>,
): Promise<{ value: T; taskRunIds: string[] }> {
  const ids: string[] = [];
  let result: TaskTextResult;
  try {
    result = await invoke();
    if (result.task_run_id) ids.push(result.task_run_id);
  } catch (error) {
    if (!(error instanceof AgentRunError)) throw error;
    ids.push(error.taskRunId);
    const [row] = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, error.taskRunId));
    const settled = row?.finished_at != null && row.status !== 'running';
    const transport = settled ? row.usage_json.transport : undefined;
    const httpStatus = settled ? boundTerminalHttpStatus(error, transport) : null;
    const verdict = settled ? providerTransientVerdict({ error, transport }) : undefined;
    const knownTerminal =
      settled &&
      (verdict !== undefined ||
        httpStatus != null ||
        error.subtype === 'error_max_structured_output_retries' ||
        error.helpProviderFault?.kind === 'parse');
    if (knownTerminal) throw new AdmissionAttemptExhausted(error.message, ids);
    throw error;
  }
  try {
    return { value: await validate(result), taskRunIds: ids };
  } catch (error) {
    if (!(error instanceof AdmissionParseFailure)) throw error;
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
}
