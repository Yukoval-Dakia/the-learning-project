import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/server/conjecture/probe-evidence';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/public';
import type {
  InterventionPackageT,
  InterventionPreparationAttemptT,
} from '@/core/schema/intervention';
import {
  InterventionPreparationAttempt,
  MAX_INTERVENTION_PACKAGE_ATTEMPTS,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { recommendPedagogy } from './recommend';
import {
  type InterventionRecord,
  activateIntervention,
  appendPreparationAttempt,
  failInterventionPreparation,
  loadInterventionVersion,
  saveRecommendation,
} from './store';

export type AuthorInterventionPackageFn = (
  db: Db,
  interventionId: string,
  deps: { attempt: 1 | 2; runTaskFn?: TaskTextRunFn; preparationJobId: string },
) => Promise<InterventionPreparationAttemptT>;

export interface PrepareInterventionWaveDeps {
  runTaskFn?: TaskTextRunFn;
  authorPackageFn: AuthorInterventionPackageFn;
  now?: () => Date;
}

export type PrepareInterventionWaveResult =
  | {
      status: 'active';
      intervention_id: string;
      version: number;
      idempotent: boolean;
      delivery_mode: 'shadow' | 'eligible';
    }
  | {
      status: 'preparation_failed';
      intervention_id: string;
      version: number;
      reason_code: string;
      idempotent: boolean;
    }
  | {
      status: 'skipped';
      intervention_id: string;
      version: number;
      terminal_status: string;
    };

async function revalidateForPaidPreparationStage(
  db: Db,
  input: {
    interventionId: string;
    version: number;
    idempotencyKey: string;
    preparationJobId: string;
  },
  now: Date,
): Promise<
  | { status: 'ready'; record: InterventionRecord }
  | { status: 'terminal'; result: PrepareInterventionWaveResult }
> {
  const record = await loadInterventionVersion(db, input.interventionId, input.version);
  if (!record) {
    throw new Error(`intervention ${input.interventionId}@${input.version} was not found`);
  }
  if (record.idempotency_key !== input.idempotencyKey) {
    throw new Error(`intervention ${input.interventionId}@${input.version} idempotency mismatch`);
  }
  if (record.status === 'active') {
    return {
      status: 'terminal',
      result: {
        status: 'active',
        intervention_id: record.id,
        version: record.version,
        idempotent: true,
        delivery_mode: record.delivery_mode,
      },
    };
  }
  if (record.status === 'preparation_failed') {
    return {
      status: 'terminal',
      result: {
        status: 'preparation_failed',
        intervention_id: record.id,
        version: record.version,
        reason_code: record.failure_code ?? 'preparation_failed',
        idempotent: true,
      },
    };
  }
  if (record.status !== 'preparing') {
    return {
      status: 'terminal',
      result: {
        status: 'skipped',
        intervention_id: record.id,
        version: record.version,
        terminal_status: record.status,
      },
    };
  }
  if (record.preparation_job_id !== input.preparationJobId) {
    return {
      status: 'terminal',
      result: {
        status: 'skipped',
        intervention_id: record.id,
        version: record.version,
        terminal_status: 'preparation_job_superseded',
      },
    };
  }

  const effective = await getEffectiveProbeResultStatuses(
    db,
    [record.source_probe_result_event_id],
    { validateDirectChain: true },
  );
  if (effective.get(record.source_probe_result_event_id) === 'active') {
    return { status: 'ready', record };
  }

  const failed = await failInterventionPreparation(db, {
    interventionId: record.id,
    version: record.version,
    expectedPreparationJobId: input.preparationJobId,
    failureCode: 'source_evidence_inactive',
    now,
  });
  if (failed.status === 'preparation_failed') {
    return {
      status: 'terminal',
      result: {
        status: 'preparation_failed',
        intervention_id: failed.id,
        version: failed.version,
        reason_code: failed.failure_code ?? 'source_evidence_inactive',
        idempotent: false,
      },
    };
  }
  // Restore/recovery may have replaced the operational job between the read
  // and the serialized failure write. The old worker must become a no-op.
  return {
    status: 'terminal',
    result: {
      status: 'skipped',
      intervention_id: failed.id,
      version: failed.version,
      terminal_status:
        failed.preparation_job_id === input.preparationJobId
          ? failed.status
          : 'preparation_job_superseded',
    },
  };
}

function bindAttemptToRecord(
  record: InterventionRecord,
  attempt: InterventionPreparationAttemptT,
): InterventionPreparationAttemptT {
  if (attempt.kind === 'author_failed') return attempt;
  const failures = [...attempt.deterministic_failure_codes];
  if (
    attempt.package.intervention_id !== record.id ||
    attempt.package.intervention_version !== record.version
  ) {
    failures.push('agency:lineage_mismatch');
  }
  if (
    !record.recommendation ||
    record.recommendation.kind !== 'recommendation' ||
    attempt.package.method_id !== record.recommendation.method_id ||
    attempt.package.method_definition_version !== record.recommendation.method_definition_version
  ) {
    failures.push('agency:method_mismatch');
  }
  if (attempt.review.package_digest_sha256 !== sha256CanonicalJson(attempt.package)) {
    failures.push('agency:review_package_digest_mismatch');
  }
  return InterventionPreparationAttempt.parse({
    ...attempt,
    deterministic_failure_codes: [...new Set(failures)].sort(),
  });
}

function passingAttempt(
  attempts: InterventionPreparationAttemptT[],
): Extract<InterventionPreparationAttemptT, { kind: 'reviewed_package' }> | null {
  for (const attempt of attempts) {
    if (
      attempt.kind === 'reviewed_package' &&
      attempt.review.result.verdict === 'pass' &&
      attempt.deterministic_failure_codes.length === 0
    ) {
      return attempt;
    }
  }
  return null;
}

function terminalAttemptFailure(attempt: InterventionPreparationAttemptT | undefined): string {
  if (!attempt) return 'package_attempt_missing';
  if (attempt.kind === 'author_failed') return attempt.failure_code;
  const codes = [...attempt.review.result.failure_codes, ...attempt.deterministic_failure_codes];
  return codes.length > 0
    ? `package_quality:${[...new Set(codes)].sort().join(',')}`
    : 'package_failed';
}

export async function prepareInterventionWave(
  db: Db,
  input: {
    interventionId: string;
    version: number;
    idempotencyKey: string;
    preparationJobId: string;
  },
  deps: PrepareInterventionWaveDeps,
): Promise<PrepareInterventionWaveResult> {
  const initialGuard = await revalidateForPaidPreparationStage(
    db,
    input,
    deps.now?.() ?? new Date(),
  );
  if (initialGuard.status === 'terminal') return initialGuard.result;
  let record = initialGuard.record;

  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  if (!record.recommendation) {
    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, [
      record.snapshot.conjecture.knowledge_id,
    ]);
    const recommendation = await recommendPedagogy({
      snapshot: record.snapshot,
      runTaskFn,
      subjectProfile,
    });
    record = await saveRecommendation(db, record, recommendation, deps.now?.() ?? new Date());
  }

  const authorStageGuard = await revalidateForPaidPreparationStage(
    db,
    input,
    deps.now?.() ?? new Date(),
  );
  if (authorStageGuard.status === 'terminal') return authorStageGuard.result;
  record = authorStageGuard.record;

  if (!record.recommendation) {
    // A concurrent writer won the optimistic update but did not expose a valid
    // recommendation. Reload once; persistent absence is an invariant failure
    // that should be retried, not silently translated into a generic KC task.
    record = (await loadInterventionVersion(db, input.interventionId, input.version)) ?? record;
    if (!record.recommendation) throw new Error('intervention recommendation did not persist');
  }
  if (record.recommendation.kind === 'abstain') {
    const failed = await failInterventionPreparation(db, {
      interventionId: record.id,
      version: record.version,
      expectedPreparationJobId: input.preparationJobId,
      failureCode: `recommendation:${record.recommendation.reason_code}`,
      now: deps.now?.() ?? new Date(),
    });
    if (failed.status !== 'preparation_failed') {
      return {
        status: 'skipped',
        intervention_id: failed.id,
        version: failed.version,
        terminal_status:
          failed.preparation_job_id === input.preparationJobId
            ? failed.status
            : 'preparation_job_superseded',
      };
    }
    return {
      status: 'preparation_failed',
      intervention_id: failed.id,
      version: failed.version,
      reason_code: failed.failure_code ?? 'recommendation_abstained',
      idempotent: false,
    };
  }

  while (record.status === 'preparing') {
    const attemptStageGuard = await revalidateForPaidPreparationStage(
      db,
      input,
      deps.now?.() ?? new Date(),
    );
    if (attemptStageGuard.status === 'terminal') return attemptStageGuard.result;
    record = attemptStageGuard.record;

    const passed = passingAttempt(record.preparation_attempts);
    if (passed) {
      const active = await activateIntervention(db, {
        interventionId: record.id,
        version: record.version,
        preparationJobId: input.preparationJobId,
        package: passed.package,
        now: deps.now?.() ?? new Date(),
      });
      if (active.status === 'preparation_failed') {
        return {
          status: 'preparation_failed',
          intervention_id: active.id,
          version: active.version,
          reason_code: active.failure_code ?? 'source_evidence_inactive',
          idempotent: false,
        };
      }
      if (active.status !== 'active') {
        return {
          status: 'skipped',
          intervention_id: active.id,
          version: active.version,
          terminal_status:
            active.preparation_job_id === input.preparationJobId
              ? active.status
              : 'preparation_job_superseded',
        };
      }
      return {
        status: 'active',
        intervention_id: active.id,
        version: active.version,
        idempotent: false,
        delivery_mode: active.delivery_mode,
      };
    }

    if (record.preparation_attempts.length >= MAX_INTERVENTION_PACKAGE_ATTEMPTS) {
      const reason = terminalAttemptFailure(record.preparation_attempts.at(-1));
      const failed = await failInterventionPreparation(db, {
        interventionId: record.id,
        version: record.version,
        expectedPreparationJobId: input.preparationJobId,
        failureCode: reason,
        now: deps.now?.() ?? new Date(),
      });
      if (failed.status !== 'preparation_failed') {
        return {
          status: 'skipped',
          intervention_id: failed.id,
          version: failed.version,
          terminal_status:
            failed.preparation_job_id === input.preparationJobId
              ? failed.status
              : 'preparation_job_superseded',
        };
      }
      return {
        status: 'preparation_failed',
        intervention_id: failed.id,
        version: failed.version,
        reason_code: failed.failure_code ?? reason,
        idempotent: false,
      };
    }

    const attemptNumber = (record.preparation_attempts.length + 1) as 1 | 2;
    const authored = await deps.authorPackageFn(db, record.id, {
      attempt: attemptNumber,
      runTaskFn,
      preparationJobId: input.preparationJobId,
    });
    if (authored.attempt !== attemptNumber) {
      throw new Error(
        `QuestionAuthor returned attempt ${authored.attempt}; expected ${attemptNumber}`,
      );
    }
    const postAuthorGuard = await revalidateForPaidPreparationStage(
      db,
      input,
      deps.now?.() ?? new Date(),
    );
    if (postAuthorGuard.status === 'terminal') return postAuthorGuard.result;
    record = postAuthorGuard.record;
    const boundAttempt = bindAttemptToRecord(record, authored);
    record = await appendPreparationAttempt(db, record, boundAttempt, deps.now?.() ?? new Date());
    if (record.status !== 'preparing') break;
  }

  if (record.status === 'active') {
    return {
      status: 'active',
      intervention_id: record.id,
      version: record.version,
      idempotent: true,
      delivery_mode: record.delivery_mode,
    };
  }
  if (record.status === 'preparation_failed') {
    return {
      status: 'preparation_failed',
      intervention_id: record.id,
      version: record.version,
      reason_code: record.failure_code ?? 'preparation_failed',
      idempotent: true,
    };
  }
  return {
    status: 'skipped',
    intervention_id: record.id,
    version: record.version,
    terminal_status: record.status,
  };
}
