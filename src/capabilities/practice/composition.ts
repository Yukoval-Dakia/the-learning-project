// Practice composition entry: installs every kernel port Practice owns into the
// process-wide host-operation slots. installPracticeHost covers API / Start
// acceptance hosts, repair scripts and DB tests; installPracticeWorker adds the
// worker-only bindings. Each install fills an independent slot — order is
// explicit here, no timing coupling. An uninstalled port call throws
// HostOperationNotInstalledError at the call site.

import { loadReviewDueReader } from './scheduling/public';

// Binds the operations Practice owns behind kernel ports that API routes and worker
// jobs both call. Hosts call this before serving or mounting handlers.
async function installPracticeHostOperationPorts(): Promise<void> {
  const [
    { installReviewAnswerBindingOperations },
    { installReviewDueReader },
    { installConversationConfirmationAssessment },
    { installJudgeOperations },
    { captureReviewAnswerBinding, consumeReviewAnswerBinding, withdrawCapturedOccurrence },
    grading,
    executeGetReviewDue,
    { issueConversationConfirmation, readConversationConfirmation, submitConversationConfirmation },
  ] = await Promise.all([
    import('@/kernel/records/review-answer-binding'),
    import('@/kernel/read-models/review-due'),
    import('@/kernel/records/conversation-confirmation-assessment'),
    import('@/kernel/judge'),
    import('./settlement/public'),
    import('./grading/public'),
    loadReviewDueReader(),
    import('./server/conversation-confirmation'),
  ]);
  installReviewAnswerBindingOperations({
    capture: captureReviewAnswerBinding,
    consume: consumeReviewAnswerBinding,
  });
  installReviewDueReader(executeGetReviewDue);
  installConversationConfirmationAssessment({
    issue: issueConversationConfirmation,
    submit: submitConversationConfirmation,
    read: readConversationConfirmation,
  });
  installJudgeOperations({
    previewFormalAttempt: grading.previewFormalAttempt,
    commitFormalAttempt: grading.commitFormalAttempt,
    recordFormalAttemptCapture: grading.recordFormalAttemptCapture,
    saveSubmission: grading.saveSubmission,
    withdrawCapturedOccurrence,
  });
}

/**
 * YUK-1770 — installs practice's today-recompose operation behind the kernel
 * steering port. Agency's steering subscription calls the port and never
 * imports practice (cross-capability value edges are decrease-only).
 */
async function installTodayPracticeRecompose(): Promise<void> {
  const [{ installTodayPracticeRecompose: install, installSteeringDeferredDueCount }] =
    await Promise.all([import('@/kernel/steering-recompose')]);
  // Both operations ride the scheduling sub-owner's own public seam — the
  // capability barrel must not enter scheduling/server directly
  // (pnpm audit:practice-subowners).
  const { recomposePracticeStream, countSteeringDeferredDueReviews } = await import(
    './scheduling/public'
  );
  install((db) => recomposePracticeStream(db, {}));
  installSteeringDeferredDueCount((db, now) => countSteeringDeferredDueReviews(db, { now }));
}

/** Every port an API, Start acceptance or script host needs, in an explicit order. */
export async function installPracticeHost(): Promise<void> {
  await installPracticeHostOperationPorts();
  const { installModelAdmissionPins } = await import('./grading/public');
  await installModelAdmissionPins();
  const { installSchedulingCandidateRebuild } = await import('./settlement/public');
  installSchedulingCandidateRebuild();
}

/** Worker bindings: the host set plus worker-only facts and paid stages. */
export async function installPracticeWorker(): Promise<void> {
  await installPracticeHost();
  const [
    { installDailyReviewPlanFacts },
    { installInterventionAuthorStages },
    { installInterventionDiagnosticLeaves },
  ] = await Promise.all([
    import('./scheduling/public'),
    import('./question-bank/public'),
    import('./grading/public'),
  ]);
  await installDailyReviewPlanFacts();
  await installTodayPracticeRecompose();
  await installInterventionAuthorStages();
  await installInterventionDiagnosticLeaves();
}
