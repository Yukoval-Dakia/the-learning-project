// Background solution-method annotation for one ingested question.
//
// Deliberately receives only the prompt/kind/knowledge label — never reference_md —
// so the annotation cannot become an answer key. Parse and provider failures throw;
// the caller counts a bounded attempt and the row stays unannotated for retry.
import { eq } from 'drizzle-orm';
import type { TaskTextResult } from '@/ai/task-result';
import {
  SOLUTION_ANNOTATION_CONTRACT,
  SolutionAnnotationOutput,
  type SolutionAnnotationOutputT,
  type StoredSolutionAnnotationT,
} from '@/core/schema/solution-annotation';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { markAiTaskRunOutputInvalid } from '@/server/ai/log';
import { type RunTaskCallCtx, makeRunTaskTextFn } from '@/server/ai/runner-fn';

export class SolutionAnnotationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SolutionAnnotationError';
  }
}

export type SolutionAnnotationRunTaskFn = (
  kind: string,
  input: unknown,
  ctx?: RunTaskCallCtx,
) => Promise<TaskTextResult>;

export interface GenerateSolutionAnnotationParams {
  db: Db;
  promptMd: string;
  kind: string;
  /** First attributed knowledge name, or null when the question is still unlabelled. */
  knowledgeLabel: string | null;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: SolutionAnnotationRunTaskFn;
  ctx?: RunTaskCallCtx;
}

export async function generateSolutionAnnotation(
  params: GenerateSolutionAnnotationParams,
): Promise<StoredSolutionAnnotationT & { cost_usd?: number }> {
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db);
  let text: string;
  let taskRunId: string | undefined;
  let costUsd: number | undefined;
  try {
    const result = await runTaskFn(
      'IngestionSolutionAnnotationTask',
      {
        prompt_md: params.promptMd,
        kind: params.kind,
        knowledge_label: params.knowledgeLabel,
      },
      params.ctx,
    );
    text = result.text;
    taskRunId = result.task_run_id;
    costUsd = result.cost_usd;
  } catch (err) {
    throw new SolutionAnnotationError('IngestionSolutionAnnotationTask LLM call failed', {
      cause: err,
    });
  }

  let parsed: SolutionAnnotationOutputT;
  try {
    parsed = SolutionAnnotationOutput.parse(extractJsonObject(text));
  } catch (err) {
    if (taskRunId !== undefined) {
      try {
        await markAiTaskRunOutputInvalid(
          params.db,
          taskRunId,
          err instanceof Error ? err.message : String(err),
        );
      } catch (markErr) {
        console.error('[solution_annotation] failed to mark invalid task output', markErr);
      }
    }
    throw new SolutionAnnotationError(
      'IngestionSolutionAnnotationTask output did not match SolutionAnnotationOutput schema',
      { cause: err },
    );
  }

  const facts = await runFacts(params.db, taskRunId);
  return {
    ...parsed,
    contract: SOLUTION_ANNOTATION_CONTRACT,
    task_run_id: taskRunId ?? null,
    provider: facts.provider,
    model: facts.model,
    generated_at: new Date().toISOString(),
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
  };
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('IngestionSolutionAnnotationTask output did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function runFacts(
  db: Db,
  taskRunId: string | undefined,
): Promise<{ provider: string; model: string }> {
  if (taskRunId === undefined) return { provider: 'unknown', model: 'unknown' };
  try {
    const [row] = await db
      .select({ provider: ai_task_runs.provider, model: ai_task_runs.model })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId))
      .limit(1);
    return { provider: row?.provider ?? 'unknown', model: row?.model ?? 'unknown' };
  } catch {
    return { provider: 'unknown', model: 'unknown' };
  }
}
