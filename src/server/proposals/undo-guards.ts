// Composition root for the auto-applied batch-undo guards.
//
// Kernel owns the batch mechanics; each capability owns the later-content rules
// for the kinds whose accept it owns, and answers cross-owner reference questions
// from its own rows. Kernel cannot import a capability and the shell read model
// cannot import the platform, so both reach the assembled registry through the
// kernel port installed here — once per host process, before serving or mounting
// jobs.
//
// Adding a batch-undoable kind therefore means writing its guard beside its
// accept/retract appliers and naming it here; adding a reference (a new row type
// that can point at an auto-applied effect) means adding a probe to the owning
// capability's public surface and passing it in below.

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
  knowledgeNodesWithMisconceptionEdges,
  knowledgeNodesWithLearningRecords,
  knowledgeNodesWithPlacementClaims,
  learningItemsWithAnswerDrafts,
  learningItemsWithLearningRecords,
} from '@/capabilities/practice/public';
import {
  type AutoAppliedUndoGuardRegistry,
  installAutoAppliedUndoGuardRegistry,
} from '@/kernel/proposals/auto-applied-undo';

export function buildProposalUndoGuards(): AutoAppliedUndoGuardRegistry {
  return new Map([
    [
      'knowledge_node',
      createKnowledgeNodeUndoGuard({
        learningRecords: knowledgeNodesWithLearningRecords,
        learningItems: knowledgeNodesWithLearningItems,
        noteLabels: knowledgeNodesWithNoteLabels,
        goalScopes: knowledgeNodesWithGoalScopes,
        placementClaims: knowledgeNodesWithPlacementClaims,
        misconceptionEdges: knowledgeNodesWithMisconceptionEdges,
      }),
    ],
    ['cause_category', causeCategoryUndoGuard],
    [
      'learning_item',
      createLearningItemUndoGuard({
        learningRecords: learningItemsWithLearningRecords,
        answerDrafts: learningItemsWithAnswerDrafts,
        notes: { readProposalNoteUndoFacts, lockProposalNoteArtifacts },
      }),
    ],
  ]);
}

export function installProposalUndoGuards(): void {
  installAutoAppliedUndoGuardRegistry(buildProposalUndoGuards());
}
