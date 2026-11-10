import { and, eq } from 'drizzle-orm';
import type { TaskKind } from '@/capabilities/task-registry';
import type { Db, Tx } from '@/db/client';
import { ai_task_runs } from '@/db/schema';

export {
  writeAiTaskAttemptFinished,
  writeAiTaskRunFinished,
  writeModelCatalogProbeCost,
} from '@/kernel/records/ai-attempt-facts';

type DbLike = Db | Tx;

/** Warn when a tool-calling task has no pi tool mounts configured in its context. */
export function logMissingToolMountsWarning(entry: {
  task_run_id: string;
  task_kind: string;
}): void {
  console.warn('[runTask] missing_tool_mounts', {
    event: 'missing_tool_mounts',
    task_run_id: entry.task_run_id,
    kind: entry.task_kind,
  });
}

export interface AiTaskRunStartEntry {
  id: string;
  task_kind: TaskKind;
  provider: string;
  model: string;
  input_hash: string;
  compiledPromptHash?: string;
  promptCodecVersion?: string;
  promptCodecMode?: 'cold' | 'resume';
  promptContextDigest?: string;
  started_at?: Date;
}

export async function writeAiTaskRunStarted(db: Db, entry: AiTaskRunStartEntry): Promise<void> {
  await db.insert(ai_task_runs).values({
    id: entry.id,
    task_kind: entry.task_kind,
    provider: entry.provider,
    model: entry.model,
    input_hash: entry.input_hash,
    compiled_prompt_hash: entry.compiledPromptHash ?? null,
    prompt_codec_version: entry.promptCodecVersion ?? null,
    prompt_codec_mode: entry.promptCodecMode ?? null,
    prompt_context_digest: entry.promptContextDigest ?? null,
    status: 'running',
    finish_reason: null,
    usage_json: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      numTurns: 0,
    },
    cost_usd: null,
    cost_basis: null,
    cost_ref: null,
    error_message: null,
    started_at: entry.started_at ?? new Date(),
    finished_at: null,
  });
}

/**
 * Mark a settled failure only after the next provider query actually started. A
 * missed marker is conservative (`error`); a false positive is forbidden.
 */
export async function writeAiTaskRunRetried(db: DbLike, id: string): Promise<boolean> {
  const rows = await db
    .update(ai_task_runs)
    .set({ finish_reason: 'error_retried' })
    .where(
      and(
        eq(ai_task_runs.id, id),
        eq(ai_task_runs.status, 'failure'),
        eq(ai_task_runs.finish_reason, 'error'),
      ),
    )
    .returning({ id: ai_task_runs.id });
  return rows.length === 1;
}

/**
 * A provider call that ended cleanly but whose text could not be parsed into the
 * task's contract is NOT a successful task run. Flip the just-settled success row so
 * observability and retry logic see the failure; paid usage and cost stay untouched
 * because the provider call really happened. Returns false when the row was already
 * settled as failure (or does not exist).
 *
 * Same semantics as YUK-1994 slice 3 (#2759); kept local until that PR lands.
 */
export async function markAiTaskRunOutputInvalid(
  db: DbLike,
  id: string,
  reason: string,
): Promise<boolean> {
  const rows = await db
    .update(ai_task_runs)
    .set({
      status: 'failure',
      finish_reason: 'model_output_invalid',
      error_message: reason.slice(0, 1000),
    })
    .where(and(eq(ai_task_runs.id, id), eq(ai_task_runs.status, 'success')))
    .returning({ id: ai_task_runs.id });
  return rows.length === 1;
}
