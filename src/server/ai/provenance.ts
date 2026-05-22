export interface TaskTextResult {
  text: string;
  task_run_id?: string;
  cost_usd?: number;
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
