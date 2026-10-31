// Author sequence for one intervention preparation attempt: preparation guard,
// subject profile, paid author stage, preparation guard again, paid review
// stage, then the deterministic package check. Practice owns the two paid
// stages. This module does not call them as a single forwarded author.

import type { TaskTextResult } from '@/ai/task-result';
import {
  type InterventionAuthoringContextT,
  type InterventionPackageReviewAuditT,
  type InterventionPackageT,
  InterventionPreparationAttempt,
  type InterventionPreparationAttemptT,
  validateInterventionPackageDeterministically,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { guardInterventionPreparationStage } from '@/kernel/read-models/intervention-preparation';
import { resolveSubjectProfileForKnowledgeIdsStrict } from '@/kernel/read-models/subject-profile';
import type { SubjectProfile } from '@/subjects/profile';

type PackageAuthorRun = {
  bivarianceHack(kind: string, input: unknown, ctx?: object): Promise<TaskTextResult>;
}['bivarianceHack'];

type AuthorStageResult =
  | { status: 'ok'; package: InterventionPackageT }
  | { status: 'invalid'; taskRunId?: string; failureCode: string };

type ReviewStageResult =
  | { status: 'ok'; review: InterventionPackageReviewAuditT }
  | { status: 'invalid'; failureCode: string; taskRunIds: string[] };

export interface InterventionAuthorStages {
  authorPackage: (
    runTaskFn: PackageAuthorRun,
    context: InterventionAuthoringContextT,
    subjectProfile: SubjectProfile,
  ) => Promise<AuthorStageResult>;
  reviewPackage: (input: {
    db: Db;
    runTaskFn: PackageAuthorRun;
    context: InterventionAuthoringContextT;
    packageValue: InterventionPackageT;
    subjectProfile: SubjectProfile;
    beforeEachPaidCall: () => Promise<string | null>;
  }) => Promise<ReviewStageResult>;
}

export interface InterventionAuthorCall {
  attempt?: 1 | 2;
  preparationJobId: string;
  runTaskFn?: PackageAuthorRun;
}

let installedStages: InterventionAuthorStages | undefined;

export function installInterventionAuthorStages(stages: InterventionAuthorStages): void {
  installedStages = stages;
}

export async function authorInterventionPackage(
  db: Db,
  interventionId: string,
  call: InterventionAuthorCall,
  stages: InterventionAuthorStages | undefined = installedStages,
): Promise<InterventionPreparationAttemptT> {
  if (!stages) {
    throw new Error(
      'intervention author stages are not installed; call installInterventionAuthorStages before prepare_intervention',
    );
  }
  if (!call.runTaskFn) {
    throw new Error('intervention author sequence requires a task runner');
  }
  const attempt = call.attempt ?? 1;
  const runTaskFn = call.runTaskFn;
  const authorGuard = await guardInterventionPreparationStage(
    db,
    interventionId,
    call.preparationJobId,
  );
  if (authorGuard.status !== 'ready') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      failure_code: authorGuard.status,
    });
  }
  const context = authorGuard.context;
  const subjectProfile = await resolveSubjectProfileForKnowledgeIdsStrict(db, [
    context.snapshot.conjecture.knowledge_id,
  ]);
  const authored = await stages.authorPackage(runTaskFn, context, subjectProfile);
  if (authored.status === 'invalid') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      ...(authored.taskRunId ? { author_task_run_id: authored.taskRunId } : {}),
      failure_code: authored.failureCode,
    });
  }

  const reviewGuard = await guardInterventionPreparationStage(
    db,
    interventionId,
    call.preparationJobId,
  );
  if (reviewGuard.status !== 'ready') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      author_task_run_id: authored.package.author_task_run_id,
      failure_code: reviewGuard.status,
    });
  }

  let nextGuard: Awaited<ReturnType<typeof guardInterventionPreparationStage>> | null = reviewGuard;
  const reviewed = await stages.reviewPackage({
    db,
    runTaskFn,
    context: reviewGuard.context,
    packageValue: authored.package,
    subjectProfile,
    beforeEachPaidCall: async () => {
      const guard =
        nextGuard ??
        (await guardInterventionPreparationStage(db, interventionId, call.preparationJobId));
      nextGuard = null;
      return guard.status === 'ready' ? null : guard.status;
    },
  });
  if (reviewed.status === 'invalid') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      author_task_run_id: authored.package.author_task_run_id,
      ...(reviewed.taskRunIds.length > 0 ? { validator_task_run_ids: reviewed.taskRunIds } : {}),
      failure_code: reviewed.failureCode,
    });
  }
  const deterministicFailures = validateInterventionPackageDeterministically(
    context,
    authored.package,
  );
  return InterventionPreparationAttempt.parse({
    kind: 'reviewed_package',
    attempt,
    package: authored.package,
    review: reviewed.review,
    deterministic_failure_codes: deterministicFailures,
  });
}
