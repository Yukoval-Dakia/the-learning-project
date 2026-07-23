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
  // YUK-589 (High-sec) — the digest of the exact judge result the caller is
  // asking us to trust. Only the supplied-verified path sets this; it is
  // corroborated against the digest the run itself persisted so a caller can
  // never bind a real run to a result the model did not produce.
  result_digest?: string;
}

interface TaskRunIdentity {
  id: string;
  task_kind: string;
  input_hash: string;
  provider: string;
  model: string;
  status: string;
  finished_at: Date | null;
  // YUK-589 — prompt/result identity the run persisted at execution time.
  // Nullable for rows written before this column existed (legacy runs stay
  // uncorroborated → supplied_unverified, never falsely trusted).
  prompt_fingerprint: string | null;
  result_digest: string | null;
}

export function resolveModelExecutionProvenance(
  execution: JudgeExecutionIdentity,
  kind: 'invoked' | 'supplied_verified' | 'supplied_unverified',
  run?: TaskRunIdentity,
): JudgeExecutionProvenanceT {
  const promptIdentity = {
    version: 1 as const,
    prompt_fingerprint: execution.prompt_fingerprint,
    prompt_template_revision: execution.prompt_template_revision,
  };

  // YUK-589 (Finding 4) — a caller that already knows the input is unverified
  // must never be promoted. Preserve the discriminant regardless of any run
  // match: an unverified input can never come out the other side as verified.
  if (kind === 'supplied_unverified') {
    return { ...promptIdentity, kind: 'supplied_unverified' };
  }

  const runMatches =
    run !== undefined &&
    run.id === execution.task_run_id &&
    run.task_kind === execution.task_kind &&
    run.input_hash === execution.input_hash &&
    run.status === 'success' &&
    run.finished_at !== null;

  // YUK-589 (Finding 1) — the supplied path must corroborate the exact prompt
  // AND result identity the run persisted, not merely a successful id/kind/input
  // lookup. `invoked` is the server's own just-run call and needs no such
  // cross-check (and legacy pre-column runs would have null digests).
  const identityMatches =
    kind === 'invoked' ||
    (run !== undefined &&
      run.prompt_fingerprint === execution.prompt_fingerprint &&
      execution.result_digest !== undefined &&
      run.result_digest === execution.result_digest);

  if (!runMatches || !identityMatches) {
    return {
      ...promptIdentity,
      kind: kind === 'invoked' ? 'historical_unknown' : 'supplied_unverified',
    };
  }
  return {
    ...promptIdentity,
    kind: kind === 'invoked' ? 'invoked' : 'supplied_verified',
    task_run_id: run.id,
    provider: run.provider,
    model: run.model,
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
          status: ai_task_runs.status,
          finished_at: ai_task_runs.finished_at,
          prompt_fingerprint: ai_task_runs.prompt_fingerprint,
          result_digest: ai_task_runs.result_digest,
        })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, execution.task_run_id))
        .limit(1)
    : [];
  return resolveModelExecutionProvenance(execution, kind, run);
}

/**
 * YUK-589 — persist the prompt/result digests a judge run produced onto its
 * ai_task_runs row so the supplied-verified path can later corroborate a
 * client-supplied result against what the model actually ran. Best-effort: a
 * failed update leaves the digests null, which downgrades a later supplied claim
 * to `supplied_unverified` (fail-closed) rather than trusting it.
 */
export async function persistJudgeRunDigests(
  db: Db,
  taskRunId: string,
  digests: { prompt_fingerprint: string; result_digest: string },
): Promise<void> {
  await db
    .update(ai_task_runs)
    .set({
      prompt_fingerprint: digests.prompt_fingerprint,
      result_digest: digests.result_digest,
    })
    .where(eq(ai_task_runs.id, taskRunId));
}

export function historicalUnknownExecutionProvenance(route: string): JudgeExecutionProvenanceT {
  const deterministic = deterministicExecutionProvenance(route);
  return {
    version: 1,
    kind: 'historical_unknown',
    prompt_fingerprint: deterministic.prompt_fingerprint,
    prompt_template_revision: deterministic.prompt_template_revision,
  };
}

export function suppliedUnverifiedExecutionProvenance(route: string): JudgeExecutionProvenanceT {
  const deterministic = deterministicExecutionProvenance(route);
  return {
    version: 1,
    kind: 'supplied_unverified',
    prompt_fingerprint: deterministic.prompt_fingerprint,
    prompt_template_revision: deterministic.prompt_template_revision,
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
