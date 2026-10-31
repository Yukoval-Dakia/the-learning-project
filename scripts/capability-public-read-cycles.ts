// YUK-885 (F3.11) — the capability public-read cycle catalog.
//
// DATA FOR THE AUDIT, NOT RUNTIME LOOKUP. Intra-SCC cross-capability value
// edges are catalogued here with owner, consumer, exact public symbols, the
// DTO, a bounded justification, and the review issue. The last practice ->
// agency query left that cycle (preparation stage read now lives in kernel),
// so no nontrivial SCC remains. Remaining rows are one-way edges the scanner
// still checks.
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
  // YUK-1571 — the agency -> knowledge command edge is retired. Learning-intent
  // accept calls createKnowledgeNodeFromEvents in
  // src/kernel/records/knowledge-node-birth.ts. The knowledge public adapter is gone.
  // YUK-1571 — proposal-accept note birth/dispatch moved to kernel; dreaming
  // nightly still enqueues note refines through notes/public.
  {
    owner: 'notes',
    consumer: 'agency',
    files: ['src/capabilities/agency/jobs/dreaming_nightly.ts'],
    symbols: ['enqueueDreamingNoteRefine'],
    dto: 'note-refine command',
    justification:
      'Dreaming nightly enqueues living-note refines after coach scan. Learning-intent accept note birth/dispatch now uses kernel handoff (YUK-1571).',
    reviewIssue: 'YUK-885',
    commandFiles: ['src/capabilities/agency/jobs/dreaming_nightly.ts'],
  },
  {
    owner: 'practice',
    consumer: 'agency',
    files: [
      'src/capabilities/agency/server/intervention/reconcile.ts',
      'src/capabilities/agency/server/intervention/store.ts',
    ],
    symbols: ['materializeInterventionDiagnostics', 'retireInterventionDiagnosticQuestion'],
    dto: 'intervention diagnostic materialization commands',
    justification:
      'agency owns the intervention lifecycle; practice owns diagnostic question materialization. Package authoring sequence lives in the kernel; practice supplies the paid author and review stages. The daily-plan due/budget/pace projection is the kernel read model; practice still supplies those three facts.',
    reviewIssue: 'YUK-885',
    commandFiles: [
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

  // YUK-1571 — the practice -> agency query edge is retired: the preparation
  // stage read lives in src/kernel/read-models/intervention-preparation.ts.
  // Practice imports that kernel read. Agency keeps intervention writes.
  // The quiz_verify pool-gap hint is an agency subscription on the committed
  // experimental:quiz_verify event, not a practice -> agency call.
  // YUK-1571 — the practice -> ingestion edge is retired: the content-addressed
  // source_asset write protocol moved to src/kernel/records/asset-store.ts;
  // jyeoo-candidates.ts now consumes the kernel module directly and ingestion
  // exits the SCC (asset-store compat shims keep the old import paths alive).
  // YUK-1571 — the practice -> knowledge read edge is retired. Failure-learning
  // knowledge and misconception reads live in
  // src/kernel/read-models/failure-learning-context.ts. Subject-profile
  // resolution already lived in src/kernel/read-models/subject-profile.ts.
  // Practice imports those kernel reads. The knowledge-runtime pass-through
  // and the knowledge public re-exports of the three readers are gone.
  // YUK-1571 — the copilot -> notes section projection is retired.
  // bodyBlocksToNoteSections lives in src/kernel/read-models/note-sections.ts.
  // Teaching and note reads import that projection. The notes public re-export
  // and the copilot forward are gone. Notes keeps block-tree edits.
];
