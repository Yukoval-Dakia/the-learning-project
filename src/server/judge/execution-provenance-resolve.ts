import type { JudgeExecutionProvenanceT } from '@/core/schema/event/known';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { JUDGE_PROMPT_TEMPLATE_REVISION, sha256Canonical } from './judge-execution-provenance';

export interface JudgeExecutionIdentity {
  task_kind: string;
  task_run_id?: string;
  input_hash: string;
  prompt_fingerprint: string;
  prompt_template_revision: string;
}

interface TaskRunIdentity {
  id: string;
  task_kind: string;
  input_hash: string;
  provider: string;
  model: string;
}

export function resolveModelExecutionProvenance(
  execution: JudgeExecutionIdentity,
  kind: 'invoked' | 'supplied_verified' | 'supplied_unverified',
  run?: TaskRunIdentity,
): JudgeExecutionProvenanceT {
  const matches =
    run !== undefined &&
    run.id === execution.task_run_id &&
    run.task_kind === execution.task_kind &&
    run.input_hash === execution.input_hash;
  return {
    version: 1,
    kind:
      kind === 'invoked'
        ? 'invoked'
        : kind === 'supplied_unverified' || !matches
          ? 'supplied_unverified'
          : kind,
    ...(matches
      ? { task_run_id: run.id, provider: run.provider, model: run.model }
      : execution.task_run_id
        ? { task_run_id: execution.task_run_id }
        : {}),
    prompt_fingerprint: execution.prompt_fingerprint,
    prompt_template_revision: execution.prompt_template_revision,
  };
}

export async function modelExecutionProvenance(
  db: Db,
  execution: JudgeExecutionIdentity,
  kind: 'invoked' | 'supplied_verified' | 'supplied_unverified',
): Promise<JudgeExecutionProvenanceT> {
  const [run] = execution.task_run_id
    ? await db
        .select({
          id: ai_task_runs.id,
          task_kind: ai_task_runs.task_kind,
          input_hash: ai_task_runs.input_hash,
          provider: ai_task_runs.provider,
          model: ai_task_runs.model,
        })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, execution.task_run_id))
        .limit(1)
    : [];
  return resolveModelExecutionProvenance(execution, kind, run);
}

export function historicalUnknownExecutionProvenance(route: string): JudgeExecutionProvenanceT {
  return {
    ...deterministicExecutionProvenance(route),
    kind: 'historical_unknown',
  };
}

export function suppliedUnverifiedExecutionProvenance(route: string): JudgeExecutionProvenanceT {
  return {
    ...deterministicExecutionProvenance(route),
    kind: 'supplied_unverified',
  };
}

export function deterministicExecutionProvenance(route: string): JudgeExecutionProvenanceT {
  return {
    version: 1,
    kind: 'deterministic',
    prompt_fingerprint: sha256Canonical({
      version: 1,
      task_kind: 'deterministic',
      canonical_model_input: null,
      judge_route: route,
      prompt_template_revision: JUDGE_PROMPT_TEMPLATE_REVISION,
    }),
    prompt_template_revision: JUDGE_PROMPT_TEMPLATE_REVISION,
  };
}
