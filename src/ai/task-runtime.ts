import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ModelRequestGuard } from '@/ai/request-guard';
import type { Db } from '@/db/client';
import type { ToolContext, ToolExecutionResultObservation } from '@/kernel/tools/types';

/** Worker-injected execution capabilities. Domain jobs supply task semantics and
 * scoped tools; the existing server runtime owns provider/budget/logging and Pi compilation. */
export interface TaskRuntime {
  runTask(
    kind: string,
    input: unknown,
    context: {
      db: Db;
      requestGuard: ModelRequestGuard;
      enableTransientRetry: false;
      budgetOverride: { maxIterations: number; timeoutMs: number };
      providerSessionDeadlineAt: number;
      taskRunId: string;
      lifecycleAbortController: AbortController;
      allowedTools: string[];
      piToolMounts: Array<{ type: 'custom'; tools: AgentTool[] }>;
    },
  ): Promise<{ task_run_id: string; text: string }>;
  buildDomainTools(options: {
    serverName: string;
    toolNames: readonly string[];
    taskKind: string;
    ctx: ToolContext;
    onResult?: (result: ToolExecutionResultObservation) => void | Promise<void>;
  }): AgentTool[];
}
