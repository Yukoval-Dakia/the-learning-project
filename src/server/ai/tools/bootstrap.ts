// YUK-80 / Foundation D M1 Lane B
//
// Bootstrap: register all known DomainTools into the module-level registry.
// Callers (debug endpoint, future MCP bridge in Lane C) invoke this once at
// request entry. The function is idempotent — if a tool is already present it
// is skipped, so re-imports across Next.js HMR cycles don't trip the
// registerTool duplicate guard.

import {
  getLearningItemContextTool,
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
  proposeKnowledgeEdgeTool,
  proposeKnowledgeMutationTool,
  proposeLearningItemCompletionTool,
  proposeLearningItemRelearnTool,
  proposeRecordLinksTool,
  proposeRecordPromotionTool,
  proposeVariantTool,
} from './proposal-tools';
import { queryEventsTool } from './query-events';
import { queryMistakesTool } from './query-mistakes';
import { getTool, registerTool } from './registry';
import type { DomainTool } from './types';

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
  proposeKnowledgeEdgeTool as DomainTool<unknown, unknown>,
  proposeKnowledgeMutationTool as DomainTool<unknown, unknown>,
  attributeMistakeTool as DomainTool<unknown, unknown>,
  proposeVariantTool as DomainTool<unknown, unknown>,
  proposeLearningItemCompletionTool as DomainTool<unknown, unknown>,
  proposeLearningItemRelearnTool as DomainTool<unknown, unknown>,
  proposeRecordLinksTool as DomainTool<unknown, unknown>,
  proposeRecordPromotionTool as DomainTool<unknown, unknown>,
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
