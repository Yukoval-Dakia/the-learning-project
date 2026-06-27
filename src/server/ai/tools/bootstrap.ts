// YUK-80 / Foundation D M1 Lane B
//
// Bootstrap: register all known DomainTools into the module-level registry.
// Callers (debug endpoint, future MCP bridge in Lane C) invoke this once at
// request entry. The function is idempotent — if a tool is already present it
// is skipped, so re-imports across Next.js HMR cycles don't trip the
// registerTool duplicate guard.

// ADR-0033 D6 / YUK-306 (lane D) — interactive artifact authoring pair.
import { authorArtifactTool, updateArtifactTool } from './author-artifact';
import {
  getLearningItemContextTool,
  // ADR-0032 D6-draftread (YUK-203 lane L5) — ingestion draft-layer structure reader.
  getQuestionBlockStructureTool,
  getQuestionContextTool,
  getRecordContextTool,
  getReviewDueTool,
  queryMemoryBriefTool,
  queryRecordsTool,
} from './context-readers';
import { getAttemptContextTool } from './get-attempt-context';
import {
  expandKnowledgeSubgraphTool,
  findKnowledgePathsTool,
  getSubjectGraphOverviewTool,
  queryKnowledgeTool,
} from './knowledge-readers';
import {
  attributeMistakeTool,
  authorQuestionTool,
  proposeKnowledgeEdgeTool,
  proposeKnowledgeMutationTool,
  proposeLearningItemArchiveTool,
  proposeLearningItemCompletionTool,
  proposeLearningItemDeferTool,
  proposeLearningItemRelearnTool,
  // ADR-0032 D6-B (YUK-203 lane L6) — active-question structured node edit propose tool.
  proposeQuestionEditTool,
  proposeRecordLinksTool,
  proposeRecordPromotionTool,
  proposeVariantTool,
} from './proposal-tools';
import { queryEventsTool } from './query-events';
import { queryMistakesTool } from './query-mistakes';
// ADR-0032 D9 / YUK-304 (lane B) — 题池查询 (copilot duplicate-avoidance read).
import { queryQuestionsTool } from './query-questions';
import {
  addOptionTool,
  mergeQuestionsTool,
  reassignFigureTool,
  setQuestionTypeTool,
  splitStemTool,
  updatePromptTool,
} from './question-edit-tools';
import { getTool, registerTool } from './registry';
import { searchMemoryFactsTool } from './search-memory-facts';
import type { DomainTool } from './types';
// ADR-0031 / RP-2 (YUK-304 lane B) — copilot 组卷 write (draft-allowed paper).
import { writeQuizTool } from './write-quiz';

const CORE_TOOLS: ReadonlyArray<DomainTool<unknown, unknown>> = [
  queryMistakesTool as DomainTool<unknown, unknown>,
  queryEventsTool as DomainTool<unknown, unknown>,
  getAttemptContextTool as DomainTool<unknown, unknown>,
  getSubjectGraphOverviewTool as DomainTool<unknown, unknown>,
  queryKnowledgeTool as DomainTool<unknown, unknown>,
  expandKnowledgeSubgraphTool as DomainTool<unknown, unknown>,
  findKnowledgePathsTool as DomainTool<unknown, unknown>,
  queryRecordsTool as DomainTool<unknown, unknown>,
  getRecordContextTool as DomainTool<unknown, unknown>,
  getQuestionContextTool as DomainTool<unknown, unknown>,
  getReviewDueTool as DomainTool<unknown, unknown>,
  getLearningItemContextTool as DomainTool<unknown, unknown>,
  queryMemoryBriefTool as DomainTool<unknown, unknown>,
  // YUK-203 U4 / L-memtool — Mem0 fact-layer retrieval (granted to
  // coach/dreaming/copilot only via allowlists; D7②).
  searchMemoryFactsTool as DomainTool<unknown, unknown>,
  // ADR-0032 D9 / YUK-304 (lane B) — READ_TOOLS tail; order mirrors allowlists.ts.
  queryQuestionsTool as DomainTool<unknown, unknown>,
  // ADR-0032 D6-draftread (YUK-203 lane L5) — READ_TOOLS tail; order mirrors
  // allowlists.ts (the listTools() inventory assertion depends on it).
  getQuestionBlockStructureTool as DomainTool<unknown, unknown>,
  proposeKnowledgeEdgeTool as DomainTool<unknown, unknown>,
  proposeKnowledgeMutationTool as DomainTool<unknown, unknown>,
  attributeMistakeTool as DomainTool<unknown, unknown>,
  proposeVariantTool as DomainTool<unknown, unknown>,
  proposeLearningItemCompletionTool as DomainTool<unknown, unknown>,
  proposeLearningItemRelearnTool as DomainTool<unknown, unknown>,
  proposeLearningItemDeferTool as DomainTool<unknown, unknown>,
  proposeLearningItemArchiveTool as DomainTool<unknown, unknown>,
  proposeRecordLinksTool as DomainTool<unknown, unknown>,
  proposeRecordPromotionTool as DomainTool<unknown, unknown>,
  // ADR-0032 D8 — unified author_question front door (variant|record seeds live;
  // knowledge|material seed is a typed lane-B stub).
  authorQuestionTool as DomainTool<unknown, unknown>,
  // YUK-195 — agent-callable question structure-edit write tools (draft layer).
  updatePromptTool as DomainTool<unknown, unknown>,
  addOptionTool as DomainTool<unknown, unknown>,
  setQuestionTypeTool as DomainTool<unknown, unknown>,
  splitStemTool as DomainTool<unknown, unknown>,
  mergeQuestionsTool as DomainTool<unknown, unknown>,
  reassignFigureTool as DomainTool<unknown, unknown>,
  // ADR-0031 / RP-2 (YUK-304 lane B) — PROPOSE_WRITE_TOOLS tail; order mirrors
  // allowlists.ts (the listTools() inventory assertion depends on it).
  writeQuizTool as DomainTool<unknown, unknown>,
  // ADR-0033 D6 / YUK-306 (lane D) — interactive artifact authoring pair;
  // PROPOSE_WRITE_TOOLS tail, order mirrors allowlists.ts.
  authorArtifactTool as DomainTool<unknown, unknown>,
  updateArtifactTool as DomainTool<unknown, unknown>,
  // ADR-0032 D6-B (YUK-203 lane L6) — active-question structured node edit propose;
  // PROPOSE_WRITE_TOOLS tail, order mirrors allowlists.ts (the listTools()
  // inventory assertion depends on it).
  proposeQuestionEditTool as DomainTool<unknown, unknown>,
];

let bootstrapped = false;

export function registerCoreTools(): void {
  if (bootstrapped) return;
  for (const tool of CORE_TOOLS) {
    if (!getTool(tool.name)) {
      registerTool(tool);
    }
  }
  bootstrapped = true;
}

/** Test-only: reset bootstrap latch so tests can re-register after __resetRegistryForTests(). */
export function __resetBootstrapForTests(): void {
  bootstrapped = false;
}
