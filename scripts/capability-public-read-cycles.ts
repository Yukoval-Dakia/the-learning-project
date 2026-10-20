// YUK-885 (F3.11) — the capability public-read cycle catalog.
//
// DATA FOR THE AUDIT, NOT RUNTIME LOOKUP. Every cross-capability value edge
// inside the current SCC {agency, ingestion, knowledge, notes, practice} is
// catalogued here with its owner, consumer, exact public symbols, the DTO it
// carries, a bounded justification, and the review issue that owns it.
// scripts/audit-architecture-deepening.ts enforces:
//   - every intra-SCC edge direction (and every consumer file) appears here;
//   - files NOT listed in `commandFiles` contain no write signatures and
//     consume no command symbols from the port (bounded public reads);
//   - files listed in `commandFiles` are the classified command edges — the
//     audited remainder of the issue's "zero semantic/write cycles" gate
//     (removing them requires ownership restructuring that YUK-885's
//     deletion-only scope and the dependency ratchets forbid; tracked as the
//     F4 follow-up in PLAN.md).

import type { PublicReadCycleEdge } from './audit-architecture-deepening';

export const publicReadCycleCatalog: readonly PublicReadCycleEdge[] = [
  // YUK-1571 — the agency -> ingestion read edge is retired: excerpt /
  // knowledgeContext / bodyBlockSummaries moved verbatim to
  // src/kernel/read-models/extraction-summary.ts; learning-item-context now
  // consumes the kernel read model directly.
  {
    owner: 'knowledge',
    consumer: 'agency',
    files: [
      'src/capabilities/agency/jobs/goal_scope_propose_nightly.ts',
      'src/capabilities/agency/server/goals/scope.ts',
      'src/capabilities/agency/server/misconception-promote.ts',
      'src/capabilities/agency/server/proposal-accept-applier.ts',
    ],
    symbols: [
      'archiveMisconceptionEdge',
      'createLearningIntentKnowledgeNode',
      'createMisconceptionEdge',
      'loadTreeSnapshot',
    ],
    dto: 'TreeSnapshot reads + tagging/intent commands',
    justification:
      'agency goal scoping reads the knowledge tree snapshot; misconception/intent accept paths run knowledge-owned commands. Failure-attempt and subject-resolution reads moved to kernel read models (YUK-892).',
    reviewIssue: 'YUK-885',
    commandFiles: [
      'src/capabilities/agency/server/goals/scope.ts',
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
    ],
    symbols: ['createLearningIntentNote', 'dispatchNoteGeneration', 'enqueueDreamingNoteRefine'],
    dto: 'note-refine/generation commands',
    justification:
      'dreaming enqueues note refines; learning-intent accept creates notes. The scout note-summary read moved to @/kernel/read-models/notes-read (YUK-1571).',
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
      'src/capabilities/ingestion/server/auto-enroll.ts',
      'src/capabilities/ingestion/server/image-candidate-accept.ts',
    ],
    symbols: ['NameKcFn', 'isTagKnowledgeInvariantError', 'tagKnowledge'],
    dto: 'tagging commands',
    justification:
      'ingestion enroll/import accept paths tag drafts onto the knowledge tree; subject-profile + failure reads moved to kernel read models (YUK-892).',
    reviewIssue: 'YUK-885',
    commandFiles: [
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
    files: ['src/capabilities/knowledge/server/proposals.ts'],
    symbols: ['rewriteGoalScopeOnMerge'],
    dto: 'goal-scope update command',
    justification:
      'knowledge coordinates the atomic merge; Agency owns locked scope attribution updates. The knowledge-review agent-note read moved to @/kernel/read-models/agent-note-hints (YUK-1571).',
    reviewIssue: 'YUK-953',
    commandFiles: ['src/capabilities/knowledge/server/proposals.ts'],
  },
  // YUK-1571 — the knowledge -> notes read edge is retired: node-page now
  // consumes @/kernel/read-models/{notes-read,artifact-backlinks,artifact-corrections}
  // directly; notes/public keeps the same symbols via compat re-exports.
  {
    owner: 'practice',
    consumer: 'knowledge',
    files: ['src/capabilities/knowledge/server/proposals.ts'],
    symbols: ['rewriteQuestionKnowledgeIds', 'rewriteLearningItemKnowledgeIds'],
    dto: 'merge attribution receipts',
    justification:
      'the merge transaction calls Practice-owned attribution commands instead of mutating foreign rows. The learnable-frontier graph decision moved INTO knowledge (YUK-1571): frontier-read.ts and frontier_fill_nightly.ts now consume it same-package, so they no longer cross this port. Retention reads now belong to the FSRS state owner.',
    reviewIssue: 'YUK-953',
    commandFiles: ['src/capabilities/knowledge/server/proposals.ts'],
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
      'recordQuestionPoolGap',
    ],
    dto: 'ActiveGoal / intervention authoring context reads',
    justification:
      'review due-list + intervention authoring read agency-owned goals; quiz verify submits a committed pool-gap observation, and Agency owns the coach hint policy.',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/practice/jobs/quiz_verify.ts'],
  },
  {
    owner: 'ingestion',
    consumer: 'practice',
    files: [
      // YUK-986 (Supply-Agent/1) — jyeoo-fetch queue job 退休后，candidates 模块接手
      // staged 资产持久化（同一 ingestion owner seam，r2/lock 经本模块单点转发）。
      'src/capabilities/practice/server/question-supply/jyeoo-candidates.ts',
    ],
    symbols: ['SourceAssetRow', 'lockImageStorageKey', 'persistImageAsset', 'sha256Hex'],
    dto: 'SourceAssetRow + asset persistence commands',
    justification:
      'the jyeoo supply lane (jyeoo_fetch_candidates DomainTool, YUK-986) persists staged assets through the ingestion owner. The question-context material excerpt reads moved to @/kernel/read-models/extraction-summary (YUK-1571).',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/practice/server/question-supply/jyeoo-candidates.ts'],
  },
  {
    owner: 'knowledge',
    consumer: 'practice',
    files: [
      'src/capabilities/practice/server/attempt-events.ts',
      'src/capabilities/practice/server/knowledge-runtime.ts',
      'src/capabilities/practice/server/learnable-frontier.ts',
      'src/capabilities/practice/server/question-supply/placement-starter-store.ts',
    ],
    symbols: [
      'createKnowledgeNodeFromEvents',
      'isMasteredForFrontier',
      'learnableFrontierResolved',
      'loadFailureLearningKnowledgeContext',
    ],
    dto: 'failure-learning reads, FrontierResolution, and placement knowledge creation command',
    justification:
      'Placement relinquishes its direct knowledge INSERT/event/index assembly to the Knowledge creation owner (YUK-984). This is an explicit command dependency, not a read or a kernel-hidden write. Existing failure-learning read seams remain. YUK-1571: the learnable-frontier graph decision is knowledge-owned; practice keeps the per-day capacity and id-list policy, with compatibility exports for its unchanged public contract.',
    reviewIssue: 'YUK-984',
    commandFiles: ['src/capabilities/practice/server/question-supply/placement-starter-store.ts'],
  },
];
