// Composition root for the auto-applied batch-undo guards.
//
// Kernel owns the batch mechanics; each capability owns the later-content rules
// for the kinds whose accept it owns, and answers cross-owner reference questions
// from its own rows. Kernel cannot import a capability and the shell read model
// cannot import the platform, so both reach the assembled registry through the
// kernel port installed here — once per host process, before serving or mounting
// jobs.
//
// Adding a batch-undoable kind means flipping its strength to A in
// `src/core/schema/proposal.ts`; this file's guard set type then requires one
// entry per strength-A kind, and installation fails at startup if one is
// missing. Adding a reference (a new row type that can point at an auto-applied
// effect) means adding a probe to the owning capability's public surface and
// passing it in below.

import {
  createLearningItemUndoGuard,
  knowledgeNodesWithGoalScopes,
  knowledgeNodesWithLearningItems,
} from '@/capabilities/agency/public';
import { createKnowledgeNodeUndoGuard } from '@/capabilities/knowledge/public';
import {
  knowledgeNodesWithNoteLabels,
  lockProposalNoteArtifacts,
  readProposalNoteUndoFacts,
} from '@/capabilities/notes/public';
import {
  causeCategoryUndoGuard,
  knowledgeNodesWithLearningRecords,
  knowledgeNodesWithMisconceptionEdges,
  knowledgeNodesWithPlacementClaims,
  learningItemsWithAnswerDrafts,
  learningItemsWithLearningRecords,
} from '@/capabilities/practice/public';
import {
  type AutoAppliedUndoGuardRegistry,
  type AutoAppliedUndoGuardSet,
  createAutoAppliedUndoGuardRegistry,
  installAutoAppliedUndoGuardRegistry,
} from '@/kernel/proposals/auto-applied-undo';
import { installBatchConfirmEligibility } from '@/server/orchestration/proposal-decisions/batch-accept';

export function buildProposalUndoGuards(): AutoAppliedUndoGuardRegistry {
  const guards: AutoAppliedUndoGuardSet = {
    knowledge_node: createKnowledgeNodeUndoGuard({
      learningRecords: knowledgeNodesWithLearningRecords,
      learningItems: knowledgeNodesWithLearningItems,
      noteLabels: knowledgeNodesWithNoteLabels,
      goalScopes: knowledgeNodesWithGoalScopes,
      placementClaims: knowledgeNodesWithPlacementClaims,
      misconceptionEdges: knowledgeNodesWithMisconceptionEdges,
    }),
    learning_item: createLearningItemUndoGuard({
      learningRecords: learningItemsWithLearningRecords,
      answerDrafts: learningItemsWithAnswerDrafts,
      notes: { readProposalNoteUndoFacts, lockProposalNoteArtifacts },
    }),
    cause_category: causeCategoryUndoGuard,
  };
  return createAutoAppliedUndoGuardRegistry(guards);
}

export function installProposalUndoGuards(): void {
  installAutoAppliedUndoGuardRegistry(buildProposalUndoGuards());
  // Sibling proposal port installed at the same composition seam: the
  // batch-confirm kind set is derived from the lifecycle registry here, so the
  // kernel inbox projection can mark batch_confirm_eligible without importing
  // a capability manifest.
  installBatchConfirmEligibility();
}
