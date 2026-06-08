export interface TaskTextResult {
  text: string;
  task_run_id?: string;
  cost_usd?: number;
  /**
   * YUK-299 seam: Agent SDK structured-output passthrough. runTask's full
   * RunTaskResult (runner.ts) is a structural superset of this interface, so a
   * handler-injected TaskTextRunFn can read `result.structured_output` and do
   * three-state dispatch (structured value present / undefined / fallback).
   * undefined ⇒ outputFormat not set, endpoint unsupported, or model fell back
   * to text — caller must run the text-fallback parse.
   */
  structured_output?: unknown;
}

export type TaskTextRunFn = (kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>;

export function costUsdToMicroUsd(costUsd: number | undefined): number | null {
  return costUsd === undefined ? null : Math.round(costUsd * 1_000_000);
}

export function aiAgentRef(
  kind: string,
  result: TaskTextResult,
): {
  by: 'ai';
  task_kind: string;
  task_run_id?: string;
} {
  return {
    by: 'ai',
    task_kind: kind,
    ...(result.task_run_id ? { task_run_id: result.task_run_id } : {}),
  };
}
