import {
  type ConjectureHypothesisProposalDraftT,
  ConjectureProbePackageV2,
  type ConjectureProbePackageV2T,
  type ConjectureProbeQualityAttemptT,
  type ConjectureProbeQualityAuditT,
  ConjectureProbeReview,
  evaluateConjectureProbePackageStructure,
} from '@/core/schema/business';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import {
  type TaskTextResult,
  type TaskTextRunFn,
  sumAllKnownCostUsd,
} from '@/server/ai/provenance';
import type { SubjectProfile } from '@/subjects/profile';
import {
  ConjectureProbeAuthorOutputSchema,
  ConjectureProbeReviewOutputSchema,
} from '../../tasks/conjecture-probe';
import type { LoadedConjectureEvidenceImage } from './evidence';
import { parseTaskStructuredOutput } from './structured-output';

export type ConjectureProbeQualityTaskKind =
  | 'ConjectureProbeAuthorTask'
  | 'ConjectureProbeReviewTask';

export class ConjectureProbeQualityOperationalError extends Error {
  readonly taskKind: ConjectureProbeQualityTaskKind;

  constructor(taskKind: ConjectureProbeQualityTaskKind, message: string) {
    super(message);
    this.name = 'ConjectureProbeQualityOperationalError';
    this.taskKind = taskKind;
  }
}

export interface PrepareConjectureProbePairInput {
  hypothesis: ConjectureHypothesisProposalDraftT;
  evidencePayload: unknown;
  evidenceImages: LoadedConjectureEvidenceImage[];
  runTaskFn: TaskTextRunFn;
  subjectProfile?: SubjectProfile;
}

interface ProbeQualityResultBase {
  attempts: ConjectureProbeQualityAttemptT[];
  task_run_ids: string[];
  cost_usd: number | null;
}

export type PrepareConjectureProbePairResult =
  | (ProbeQualityResultBase & {
      outcome: 'passed';
      package: ConjectureProbePackageV2T;
      audit: ConjectureProbeQualityAuditT;
      primary_task_run_id: string | null;
    })
  | (ProbeQualityResultBase & {
      outcome: 'rejected';
    });

function taskInput(
  payload: unknown,
  evidenceImages: LoadedConjectureEvidenceImage[],
): {
  text: string;
  images: Array<{ data: string; mediaType: LoadedConjectureEvidenceImage['mediaType'] }>;
} {
  return {
    text: JSON.stringify(payload),
    images: evidenceImages.map(({ data, mediaType }) => ({ data, mediaType })),
  };
}

/**
 * Author and independently review one whole pair. A quality failure gets exactly one
 * fresh authoring attempt; a second failure returns `rejected`. Provider/parse failures
 * remain operational so the nightly worker retries instead of treating an outage as
 * evidence against the conjecture.
 */
export async function prepareConjectureProbePair(
  input: PrepareConjectureProbePairInput,
): Promise<PrepareConjectureProbePairResult> {
  const attempts: ConjectureProbeQualityAttemptT[] = [];
  const taskRunIds: string[] = [];
  const costsUsd: Array<number | null | undefined> = [];
  let operationalFailureSeen = false;
  let lastOperationalTaskKind: ConjectureProbeQualityTaskKind = 'ConjectureProbeAuthorTask';

  const rejectOrThrow = (): PrepareConjectureProbePairResult => {
    if (operationalFailureSeen) {
      throw new ConjectureProbeQualityOperationalError(
        lastOperationalTaskKind,
        'probe quality gate exhausted its two authoring attempts after an operational failure; retry the worker instead of treating this as evidence',
      );
    }
    return {
      outcome: 'rejected',
      attempts,
      task_run_ids: taskRunIds,
      cost_usd: sumAllKnownCostUsd(costsUsd),
    };
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let authorResult: TaskTextResult;
    try {
      authorResult = await input.runTaskFn(
        'ConjectureProbeAuthorTask',
        taskInput(
          {
            frozen_hypothesis: input.hypothesis,
            evidence: input.evidencePayload,
            generation_attempt: attempt,
            ...(attempts.length > 0 ? { prior_quality_failures: attempts } : {}),
          },
          input.evidenceImages,
        ),
        {
          override: { provider: 'anthropic-sub' as const },
          outputFormat: zodToJsonSchemaOutputFormat(ConjectureProbeAuthorOutputSchema),
          ...(input.subjectProfile ? { subjectProfile: input.subjectProfile } : {}),
        },
      );
    } catch (error) {
      costsUsd.push(null);
      operationalFailureSeen = true;
      lastOperationalTaskKind = 'ConjectureProbeAuthorTask';
      if (attempt < 2) {
        attempts.push({
          attempt,
          outcome: 'operational_failed',
          failure_codes: ['author_operational_failure'],
          explanation_md: 'Probe author call failed operationally; the whole pair was retried.',
          author_task_run_id: null,
          reviewer_task_run_id: null,
        });
        continue;
      }
      throw new ConjectureProbeQualityOperationalError(
        'ConjectureProbeAuthorTask',
        `probe author failed twice: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (authorResult.task_run_id) taskRunIds.push(authorResult.task_run_id);
    costsUsd.push(authorResult.cost_usd);
    if (!authorResult.task_run_id) {
      operationalFailureSeen = true;
      lastOperationalTaskKind = 'ConjectureProbeAuthorTask';
      if (attempt < 2) {
        attempts.push({
          attempt,
          outcome: 'operational_failed',
          failure_codes: ['author_operational_failure'],
          explanation_md: 'Probe author completed without durable task-run lineage.',
          author_task_run_id: null,
          reviewer_task_run_id: null,
        });
        continue;
      }
      throw new ConjectureProbeQualityOperationalError(
        'ConjectureProbeAuthorTask',
        'probe author completed twice without durable task-run lineage',
      );
    }
    const authorTaskRunId = authorResult.task_run_id;
    const probePackage = parseTaskStructuredOutput(
      authorResult,
      ConjectureProbePackageV2,
      'package',
    );
    if (!probePackage) {
      operationalFailureSeen = true;
      lastOperationalTaskKind = 'ConjectureProbeAuthorTask';
      if (attempt < 2) {
        attempts.push({
          attempt,
          outcome: 'operational_failed',
          failure_codes: ['author_output_invalid'],
          explanation_md: 'Author output did not satisfy the structured probe-package contract.',
          author_task_run_id: authorTaskRunId,
          reviewer_task_run_id: null,
        });
        continue;
      }
      throw new ConjectureProbeQualityOperationalError(
        'ConjectureProbeAuthorTask',
        'probe author produced invalid structured output twice',
      );
    }

    const structuralFailures = evaluateConjectureProbePackageStructure(probePackage);
    if (structuralFailures.length > 0) {
      attempts.push({
        attempt,
        outcome: 'structure_failed',
        failure_codes: structuralFailures,
        explanation_md: 'The pair failed subject-neutral structure checks before semantic review.',
        author_task_run_id: authorTaskRunId,
        reviewer_task_run_id: null,
      });
      if (attempt < 2) continue;
      return rejectOrThrow();
    }

    let reviewResult: TaskTextResult;
    try {
      reviewResult = await input.runTaskFn(
        'ConjectureProbeReviewTask',
        taskInput(
          {
            frozen_hypothesis: input.hypothesis,
            evidence: input.evidencePayload,
            probe_package: probePackage,
            generation_attempt: attempt,
          },
          input.evidenceImages,
        ),
        {
          override: { provider: 'anthropic-sub' as const },
          outputFormat: zodToJsonSchemaOutputFormat(ConjectureProbeReviewOutputSchema),
          ...(input.subjectProfile ? { subjectProfile: input.subjectProfile } : {}),
        },
      );
    } catch (error) {
      costsUsd.push(null);
      operationalFailureSeen = true;
      lastOperationalTaskKind = 'ConjectureProbeReviewTask';
      if (attempt < 2) {
        attempts.push({
          attempt,
          outcome: 'operational_failed',
          failure_codes: ['review_operational_failure'],
          explanation_md: 'Independent review did not complete; the whole pair was regenerated.',
          author_task_run_id: authorTaskRunId,
          reviewer_task_run_id: null,
        });
        continue;
      }
      throw new ConjectureProbeQualityOperationalError(
        'ConjectureProbeReviewTask',
        `probe reviewer failed twice: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (reviewResult.task_run_id) taskRunIds.push(reviewResult.task_run_id);
    costsUsd.push(reviewResult.cost_usd);
    if (!reviewResult.task_run_id) {
      operationalFailureSeen = true;
      lastOperationalTaskKind = 'ConjectureProbeReviewTask';
      if (attempt < 2) {
        attempts.push({
          attempt,
          outcome: 'operational_failed',
          failure_codes: ['review_operational_failure'],
          explanation_md: 'Probe reviewer completed without durable task-run lineage.',
          author_task_run_id: authorTaskRunId,
          reviewer_task_run_id: null,
        });
        continue;
      }
      throw new ConjectureProbeQualityOperationalError(
        'ConjectureProbeReviewTask',
        'probe reviewer completed twice without durable task-run lineage',
      );
    }
    const reviewerTaskRunId = reviewResult.task_run_id;
    const review = parseTaskStructuredOutput(reviewResult, ConjectureProbeReview, 'review');
    if (!review) {
      operationalFailureSeen = true;
      lastOperationalTaskKind = 'ConjectureProbeReviewTask';
      if (attempt < 2) {
        attempts.push({
          attempt,
          outcome: 'operational_failed',
          failure_codes: ['review_output_invalid'],
          explanation_md: 'Independent review output was invalid; the whole pair was regenerated.',
          author_task_run_id: authorTaskRunId,
          reviewer_task_run_id: reviewerTaskRunId,
        });
        continue;
      }
      throw new ConjectureProbeQualityOperationalError(
        'ConjectureProbeReviewTask',
        'probe reviewer produced invalid structured output twice',
      );
    }

    if (review.verdict === 'fail') {
      attempts.push({
        attempt,
        outcome: 'review_failed',
        failure_codes: review.failure_codes,
        explanation_md: review.explanation_md,
        author_task_run_id: authorTaskRunId,
        reviewer_task_run_id: reviewerTaskRunId,
      });
      if (attempt < 2) continue;
      return rejectOrThrow();
    }

    const passedAttempt: ConjectureProbeQualityAttemptT = {
      attempt,
      outcome: 'passed',
      failure_codes: [],
      explanation_md: review.explanation_md,
      author_task_run_id: authorTaskRunId,
      reviewer_task_run_id: reviewerTaskRunId,
    };
    attempts.push(passedAttempt);
    return {
      outcome: 'passed',
      package: probePackage,
      audit: {
        schema_version: 3,
        passed: true,
        attempts: structuredClone(attempts),
        final_review: review,
        reviewed_hypothesis: structuredClone(input.hypothesis),
        reviewed_package: structuredClone(probePackage),
      },
      primary_task_run_id: authorTaskRunId,
      attempts: structuredClone(attempts),
      task_run_ids: taskRunIds,
      cost_usd: sumAllKnownCostUsd(costsUsd),
    };
  }

  throw new Error('prepareConjectureProbePair: unreachable');
}
