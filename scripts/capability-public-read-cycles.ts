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
    files: ['src/capabilities/agency/server/proposal-accept-applier.ts'],
    symbols: ['createLearningIntentKnowledgeNode'],
    dto: 'knowledge intent commands',
    justification:
      'agency intent accept paths run knowledge-owned commands. Goal-scope tree snapshots now read the existing kernel owner directly (YUK-1570); failure-attempt and subject-resolution reads already moved to kernel read models (YUK-892).',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/agency/server/proposal-accept-applier.ts'],
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
      'src/capabilities/agency/server/intervention/store.ts',
    ],
    symbols: [
      'authorInterventionPackage',
      'materializeInterventionDiagnostics',
      'retireInterventionDiagnosticQuestion',
    ],
    dto: 'intervention authoring + diagnostic materialization commands',
    justification:
      'agency owns the intervention lifecycle; practice owns diagnostic question materialization and authoring. The daily-plan due/budget/pace projection is the kernel read model (YUK-1571); practice still supplies those three facts.',
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
  // YUK-1571 — the knowledge -> notes read edge is retired: node-page now
  // consumes @/kernel/read-models/{notes-read,artifact-backlinks,artifact-corrections}
  // directly; notes/public keeps the same symbols via compat re-exports.

  {
    owner: 'agency',
    consumer: 'practice',
    files: [
      'src/capabilities/practice/jobs/quiz_verify.ts',
      'src/capabilities/practice/server/intervention-author.ts',
    ],
    symbols: [
      'InterventionAuthoringContextT',
      'guardInterventionPreparationStage',
      'recordQuestionPoolGap',
    ],
    dto: 'intervention authoring context reads',
    justification:
      'intervention authoring reads the agency-owned preparation context; quiz verify submits a committed pool-gap observation, and Agency owns the coach hint policy. The active-goal effective-scope read moved to @/kernel/read-models/active-goal-scope (YUK-1571).',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/practice/jobs/quiz_verify.ts'],
  },
  // YUK-1571 — the practice -> ingestion edge is retired: the content-addressed
  // source_asset write protocol moved to src/kernel/records/asset-store.ts;
  // jyeoo-candidates.ts now consumes the kernel module directly and ingestion
  // exits the SCC (asset-store compat shims keep the old import paths alive).
  {
    owner: 'knowledge',
    consumer: 'practice',
    files: ['src/capabilities/practice/server/knowledge-runtime.ts'],
    symbols: ['loadFailureLearningKnowledgeContext'],
    dto: 'failure-learning reads',
    justification:
      'Existing failure-learning read seams remain. Placement node birth now consumes the complete shared kernel owner directly; learner authorization and the caller transaction remain in Practice.',
    reviewIssue: 'YUK-984',
    commandFiles: [],
  },
];
