// YUK-885 (F3.11) — the capability public-read cycle catalog.
//
// DATA FOR THE AUDIT, NOT RUNTIME LOOKUP. Every cross-capability value edge
// inside the current SCC {agency, ingestion, knowledge, notes, practice} is
// catalogued here with its owner, consumer, exact public symbols, the DTO it
// carries, a bounded justification, and the review issue that owns it.
// scripts/audit-architecture-ownership.ts enforces:
//   - every intra-SCC edge direction (and every consumer file) appears here;
//   - files NOT listed in `commandFiles` contain no write signatures and
//     consume no command symbols from the port (bounded public reads);
//   - files listed in `commandFiles` are the classified command edges — the
//     audited remainder of the issue's "zero semantic/write cycles" gate
//     (removing them requires ownership restructuring that YUK-885's
//     deletion-only scope and the dependency ratchets forbid; tracked as the
//     F4 follow-up in PLAN.md).

import type { PublicReadCycleEdge } from './audit-architecture-ownership';

export const publicReadCycleCatalog: readonly PublicReadCycleEdge[] = [
  {
    owner: 'ingestion',
    consumer: 'agency',
    files: ['src/capabilities/agency/server/tools/learning-item-context.ts'],
    symbols: ['bodyBlockSummaries', 'excerpt', 'knowledgeContext'],
    dto: 'record/block context excerpts (string summaries)',
    justification:
      'get_learning_item_context grounds lifecycle suggestions in ingestion-owned record + block context; pure read.',
    reviewIssue: 'YUK-885',
    commandFiles: [],
  },
  {
    owner: 'knowledge',
    consumer: 'agency',
    files: [
      'src/capabilities/agency/api/probe-answer.ts',
      'src/capabilities/agency/jobs/goal_scope_propose_nightly.ts',
      'src/capabilities/agency/jobs/research_meeting_nightly.ts',
      'src/capabilities/agency/server/conjecture/evidence-enrichment.ts',
      'src/capabilities/agency/server/goals/queries.ts',
      'src/capabilities/agency/server/goals/scope.ts',
      'src/capabilities/agency/server/intervention/prepare.ts',
      'src/capabilities/agency/server/meeting/director-tools.ts',
      'src/capabilities/agency/server/meeting/director.ts',
      'src/capabilities/agency/server/misconception-promote.ts',
      'src/capabilities/agency/server/proposal-accept-applier.ts',
      'src/capabilities/agency/server/scout/evidence-mcp.ts',
    ],
    symbols: [
      'FailureAttempt',
      'archiveMisconceptionEdge',
      'batchResolveEffectiveDomains',
      'createLearningIntentKnowledgeNode',
      'createMisconceptionEdge',
      'getFailureAttemptById',
      'getFailureAttempts',
      'getFailureAttemptsWithReasoningTrace',
      'loadTreeSnapshot',
      'resolveSubjectKnowledgeIds',
      'resolveSubjectProfileForKnowledgeIds',
      'resolveSubjectProfileForKnowledgeIdsStrict',
    ],
    dto: 'FailureAttempt / TreeSnapshot / subject-resolution reads',
    justification:
      'agency nightly chains + goal/intervention flows ground on knowledge-owned read models (failure evidence, tree snapshot, subject resolution).',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/agency/jobs/research_meeting_nightly.ts',
      'src/capabilities/agency/server/goals/queries.ts',
      'src/capabilities/agency/server/goals/scope.ts',
      'src/capabilities/agency/server/meeting/director-tools.ts',
      'src/capabilities/agency/server/misconception-promote.ts',
      'src/capabilities/agency/server/proposal-accept-applier.ts',
    ],
  },
  {
    owner: 'notes',
    consumer: 'agency',
    files: [
      'src/capabilities/agency/jobs/dreaming_nightly.ts',
      'src/capabilities/agency/server/proposal-accept-applier.ts',
      'src/capabilities/agency/server/scout/evidence-mcp.ts',
    ],
    symbols: [
      'createLearningIntentNote',
      'dispatchNoteGeneration',
      'enqueueDreamingNoteRefine',
      'notesForKnowledge',
    ],
    dto: 'note summaries + note-refine/generation commands',
    justification:
      'dreaming enqueues note refines; learning-intent accept creates notes; scout reads note summaries for evidence.',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/agency/jobs/dreaming_nightly.ts',
      'src/capabilities/agency/server/proposal-accept-applier.ts',
    ],
  },
  {
    owner: 'practice',
    consumer: 'agency',
    files: [
      'src/capabilities/agency/jobs/prepare_intervention.ts',
      'src/capabilities/agency/server/intervention/reconcile.ts',
      'src/capabilities/agency/server/intervention/settlement-subscription.ts',
      'src/capabilities/agency/server/intervention/store.ts',
    ],
    symbols: [
      'authorInterventionPackage',
      'loadLatestTrustedInterventionDiagnosticVerdict',
      'materializeInterventionDiagnostics',
      'retireInterventionDiagnosticQuestion',
    ],
    dto: 'intervention authoring + diagnostic materialization commands',
    justification:
      'agency owns the intervention lifecycle; practice owns diagnostic question materialization and authoring.',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/agency/jobs/prepare_intervention.ts',
      'src/capabilities/agency/server/intervention/reconcile.ts',
      'src/capabilities/agency/server/intervention/store.ts',
    ],
  },
  {
    owner: 'knowledge',
    consumer: 'ingestion',
    files: [
      'src/capabilities/ingestion/api/import.ts',
      'src/capabilities/ingestion/api/mistakes.ts',
      'src/capabilities/ingestion/server/auto-enroll.ts',
      'src/capabilities/ingestion/server/image-candidate-accept.ts',
      'src/capabilities/ingestion/server/tools/get-record-context.ts',
    ],
    symbols: [
      'NameKcFn',
      'assertCauseAllowedForSubjectProfile',
      'getFailureAttemptById',
      'isTagKnowledgeInvariantError',
      'resolveSubjectProfileForKnowledgeIds',
      'tagKnowledge',
    ],
    dto: 'subject-profile resolution + tagging commands + failure reads',
    justification:
      'ingestion enroll/import paths tag drafts onto the knowledge tree and resolve subject profiles; record context reads failure evidence.',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/ingestion/api/import.ts',
      'src/capabilities/ingestion/api/mistakes.ts',
      'src/capabilities/ingestion/server/auto-enroll.ts',
      'src/capabilities/ingestion/server/image-candidate-accept.ts',
    ],
  },
  {
    owner: 'practice',
    consumer: 'ingestion',
    files: [
      'src/capabilities/ingestion/api/mistakes.ts',
      'src/capabilities/ingestion/server/enroll.ts',
    ],
    symbols: ['loadAttemptQuestionSnapshot'],
    dto: 'AttemptQuestionSnapshot',
    justification: 'mistake enrollment reads the attempt question snapshot owned by practice.',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/ingestion/api/mistakes.ts',
      'src/capabilities/ingestion/server/enroll.ts',
    ],
  },
  {
    owner: 'agency',
    consumer: 'knowledge',
    files: [
      'src/capabilities/knowledge/server/proposals.ts',
      'src/capabilities/knowledge/server/review.ts',
    ],
    symbols: ['readAgentNotes', 'updateGoalScope'],
    dto: 'goal-scope update command + agent-note reads',
    justification:
      'knowledge proposals update goal scope on accept; knowledge review reads agent notes for grounding.',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/knowledge/server/proposals.ts',
      'src/capabilities/knowledge/server/review.ts',
    ],
  },
  {
    owner: 'ingestion',
    consumer: 'knowledge',
    files: ['src/capabilities/knowledge/server/tag-knowledge.ts'],
    symbols: ['ColdStartBridgeError', 'ColdStartBridgeRunTaskFn', 'runColdStartBridge'],
    dto: 'cold-start bridge runner + error type',
    justification: 'knowledge tagging delegates cold-start node bridging to the ingestion owner.',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/knowledge/server/tag-knowledge.ts'],
  },
  {
    owner: 'notes',
    consumer: 'knowledge',
    files: ['src/capabilities/knowledge/server/node-page.ts'],
    symbols: [
      'BacklinksByArtifactType',
      'NoteSummary',
      'getArtifactCorrectionStates',
      'groupBacklinksByArtifactType',
      'interactiveForKnowledge',
      'listBacklinks',
      'notesForKnowledge',
      'resolveOwningLearningItemIds',
    ],
    dto: 'NoteSummary / backlink projections',
    justification:
      'knowledge node pages render notes-owned backlinks and note summaries; pure read.',
    reviewIssue: 'YUK-885',
    commandFiles: [],
  },
  {
    owner: 'practice',
    consumer: 'knowledge',
    files: [
      'src/capabilities/knowledge/jobs/frontier_fill_nightly.ts',
      'src/capabilities/knowledge/server/events/failure-attempts.ts',
      'src/capabilities/knowledge/server/frontier-read.ts',
      'src/capabilities/knowledge/server/node-page.ts',
    ],
    symbols: [
      'EffectiveTruth',
      'FrontierResolution',
      'activeEffectiveTruth',
      'getEffectiveTruths',
      'isMasteredForFrontier',
      'learnableFrontierResolved',
      'retrievabilityForKc',
    ],
    dto: 'EffectiveTruth / FrontierResolution / FSRS retrievability reads',
    justification:
      'knowledge-owned frontier + failure read models resolve against practice-owned FSRS/effective-truth state.',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/knowledge/jobs/frontier_fill_nightly.ts',
      'src/capabilities/knowledge/server/frontier-read.ts',
    ],
  },
  {
    owner: 'knowledge',
    consumer: 'notes',
    files: [
      'src/capabilities/notes/server/hub-sync-reconciliation.ts',
      'src/capabilities/notes/server/note-page.ts',
    ],
    symbols: [
      'HubMeshAtomicInput',
      'HubMeshEdge',
      'listKnowledgeEdges',
      'loadTreeSnapshot',
      'resolveHubMeshAtomics',
      'resolveSubjectProfileForKnowledgeIds',
    ],
    dto: 'TreeSnapshot / HubMeshEdge projections',
    justification:
      'hub auto-sync reconciles note hubs against the knowledge tree; note pages resolve subject profiles.',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/notes/server/hub-sync-reconciliation.ts'],
  },
  {
    owner: 'agency',
    consumer: 'practice',
    files: [
      'src/capabilities/practice/jobs/quiz_verify.ts',
      'src/capabilities/practice/server/due-list.ts',
      'src/capabilities/practice/server/intervention-author.ts',
    ],
    symbols: [
      'ActiveGoal',
      'InterventionAuthoringContextT',
      'guardInterventionPreparationStage',
      'listActiveGoalsWithResolvedScope',
      'writeAgentNote',
    ],
    dto: 'ActiveGoal / intervention authoring context reads',
    justification:
      'review due-list + intervention authoring read agency-owned goals; quiz verify writes agent notes back.',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/practice/jobs/quiz_verify.ts'],
  },
  {
    owner: 'ingestion',
    consumer: 'practice',
    files: ['src/capabilities/practice/jobs/jyeoo-fetch.ts'],
    symbols: ['SourceAssetRow', 'lockImageStorageKey', 'persistImageAsset', 'sha256Hex'],
    dto: 'SourceAssetRow + asset persistence commands',
    justification:
      'the jyeoo scraper supply route persists scraped assets through the ingestion owner.',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/practice/jobs/jyeoo-fetch.ts'],
  },
  {
    owner: 'knowledge',
    consumer: 'practice',
    files: [
      'src/capabilities/practice/api/advice.ts',
      'src/capabilities/practice/api/question-detail.ts',
      'src/capabilities/practice/api/questions-list.ts',
      'src/capabilities/practice/api/submit.ts',
      'src/capabilities/practice/jobs/embed_backfill.ts',
      'src/capabilities/practice/jobs/jyeoo-fetch.ts',
      'src/capabilities/practice/jobs/reference_answer_backfill.ts',
      'src/capabilities/practice/jobs/rejudge.ts',
      'src/capabilities/practice/jobs/variant_verify.ts',
      'src/capabilities/practice/server/attempt-events.ts',
      'src/capabilities/practice/server/draft-review.ts',
      'src/capabilities/practice/server/due-list.ts',
      'src/capabilities/practice/server/intervention-author.ts',
      'src/capabilities/practice/server/judge-calibration-sample-core.ts',
      'src/capabilities/practice/server/knowledge-runtime.ts',
      'src/capabilities/practice/server/paper-submit.ts',
      'src/capabilities/practice/server/placement-scope.ts',
      'src/capabilities/practice/server/placement-select.ts',
      'src/capabilities/practice/server/question-supply/confusable-contrast-discovery.ts',
      'src/capabilities/practice/server/question-supply/target-discovery.ts',
      'src/capabilities/practice/server/quiz/matcher.ts',
      'src/capabilities/practice/server/solve-session.ts',
    ],
    symbols: [
      'FailureAttempt',
      'getEffectiveDomain',
      'getFailureAttemptById',
      'getFailureAttemptWithReasoningTraceById',
      'getFailureAttempts',
      'getJudgeForAttempt',
      'batchResolveSubjectDisplayIds',
      'batchResolveSubjectIds',
      'resolveAllActiveKnowledgeIds',
      'resolveSubjectKnowledgeIds',
      'resolveSubjectProfileForKnowledgeIds',
      'resolveSubjectProfileForKnowledgeIdsStrict',
      'resolveSubjectRenderNotation',
      'assertKnowledgeIdsExist',
      'loadConfusablePairs',
      'loadFailureLearningKnowledgeContext',
    ],
    dto: 'FailureAttempt / subject-resolution / profile-resolution reads',
    justification:
      'practice product surface resolves subjects, profiles, and failure evidence through the knowledge public port (see practice/server/knowledge-runtime.ts + attempt-events.ts re-publish seams).',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/practice/api/submit.ts',
      'src/capabilities/practice/jobs/embed_backfill.ts',
      'src/capabilities/practice/jobs/jyeoo-fetch.ts',
      'src/capabilities/practice/jobs/rejudge.ts',
      'src/capabilities/practice/jobs/variant_verify.ts',
      'src/capabilities/practice/server/judge-calibration-sample-core.ts',
      'src/capabilities/practice/server/paper-submit.ts',
      'src/capabilities/practice/server/solve-session.ts',
    ],
  },
];
