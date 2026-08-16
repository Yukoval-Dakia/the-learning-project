import { eq } from 'drizzle-orm';
import type { JudgeExecutionProvenanceT } from '@/core/schema/event/known';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
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
  let run: TaskRunIdentity | undefined;
  if (execution.task_run_id) {
    // YUK-589 (K3a) — a DB blip during the ai_task_runs lookup must NOT crash the
    // submit/paper/rejudge write path. Contain it: on error, resolve with NO run
    // row, which fails closed (`supplied_*` → supplied_unverified, `invoked` →
    // historical_unknown) rather than throwing. execution_provenance is an audit
    // stamp on the attempt event, never a gate on trusting the verdict.
    try {
      [run] = await db
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
        .limit(1);
    } catch (err) {
      console.warn(
        `ai_task_runs provenance lookup failed for ${execution.task_run_id} (kind '${kind}') — degrading fail-closed:`,
        err,
      );
      run = undefined;
    }
  }
  return resolveModelExecutionProvenance(execution, kind, run);
}

/**
 * YUK-589 — single source for stamping the provenance of a judge result the
 * server JUST invoked (submit auto-rate / paper slot / rejudge overturn). The
 * three consumers previously duplicated this 3-arm decision; the honest signal
 * is whether a model invocation was ATTEMPTED (`invoked.modelAttempted`), NOT
 * whether the route is model-backed — an accelerator-resolved unit_dimension
 * slot (route ∈ model set, but no model call) is deterministic, not
 * historical_unknown.
 *   - execution present  → the model ran and produced provenance → `invoked`.
 *   - model attempted, no execution → the model ran but metadata/persist failed
 *     (or the call itself failed) → `historical_unknown` (a real model run whose
 *     identity is unknown — never a no-model `deterministic` lie).
 *   - no model attempted → a local/deterministic verdict → `deterministic`.
 */
export async function resolveInvokedExecutionProvenance(
  db: Db,
  invoked: { execution?: JudgeExecutionIdentity; modelAttempted: boolean; route: string },
): Promise<JudgeExecutionProvenanceT> {
  if (invoked.execution) {
    return modelExecutionProvenance(db, invoked.execution, 'invoked');
  }
  if (invoked.modelAttempted) {
    return historicalUnknownExecutionProvenance(invoked.route);
  }
  return deterministicExecutionProvenance(invoked.route);
}

/**
 * YUK-589 — persist the prompt/result digests a judge run produced onto its
 * ai_task_runs row so the supplied-verified path can later corroborate a
 * client-supplied result against what the model actually ran. This function does
 * NOT swallow failures — it awaits the UPDATE and lets errors propagate. The
 * best-effort, fail-closed contract is enforced by the CALLER (JudgeInvoker):
 * its try/catch around this call clears the in-memory execution/task_run_id on
 * failure, so the digests stay null and a later supplied claim downgrades to
 * `supplied_unverified` rather than being falsely trusted.
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
