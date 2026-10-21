// `search_memory_facts` — read-only DomainTool over the Mem0 fact layer (pgvector),
// orthogonal to the Dreaming-maintained `query_memory_brief` note layer.
//
// Governance: granted to coach / dreaming / copilot only. Per ADR-0017 memory is an
// attention prior, not a source of truth — this tool only reads facts, never mutates
// due / mastery / FSRS, and never biases judging. mirrorEvent 'never' keeps internal
// retrieval out of the user-visible event stream.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { createMem0OpaqueOperationContext } from '@/server/ai/provider-attempt-runtime';
import { type MemoryReadClientFactory, readMemoryFacts } from '@/server/memory/read';

// Concrete default topK so the recency-rerank wrapper can overfetch + truncate;
// never pass undefined into the math.
const DEFAULT_FACTS_TOP_K = 10;

export const SearchMemoryFactsInputSchema = z.object({
  query: z.string().min(1).describe('Natural-language retrieval query for the Mem0 fact store.'),
  topK: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Max facts to return (1-20). Defaults to 10 when omitted.'),
  // ADR-0017 fixes 5 scope prefixes: global / subject:* / topic:* /
  // mistake_cluster:* / meta:orchestrator_self. TRAP: attempt/review-derived
  // learning facts carry only global + topic:* scopes, never subject:X — passing
  // a subject:yuwen scopeKey silently drops nearly all learning facts.
  scopeKey: z
    .string()
    .optional()
    .describe(
      'Optional scope filter (one of: global, subject:*, topic:*, mistake_cluster:*, meta:orchestrator_self). ' +
        'WARNING: attempt/review facts are tagged global+topic:* only, never subject:* — a subject:* filter drops most learning facts.',
    ),
});
export type SearchMemoryFactsInput = z.infer<typeof SearchMemoryFactsInputSchema>;

// Mem0 SearchResult has no project schema; project the fields we use and let
// `.passthrough()` keep extra MemoryItem fields (hash / createdAt / metadata).
export const SearchMemoryFactsOutputSchema = z.object({
  facts: z.array(
    z
      .object({
        id: z.string().optional(),
        memory: z.string().optional(),
        score: z.number().optional(),
      })
      .passthrough(),
  ),
  count: z.number(),
});
export type SearchMemoryFactsOutput = z.infer<typeof SearchMemoryFactsOutputSchema>;

// Injectable client factory: the read module owns lazy client construction because
// its env is not carried on ToolContext.
export type MemoryClientFactory = MemoryReadClientFactory;

export function buildSearchMemoryFactsTool(
  opts: { memoryFactory?: MemoryClientFactory } = {},
): DomainTool<SearchMemoryFactsInput, SearchMemoryFactsOutput> {
  const readDeps = opts.memoryFactory ? { createClient: opts.memoryFactory } : undefined;

  async function execute(
    ctx: ToolContext,
    input: SearchMemoryFactsInput,
  ): Promise<SearchMemoryFactsOutput> {
    // Read through the searchMemories wrapper: soft-superseded facts are filtered
    // out and survivors recency-reranked. `user_id` is forced to 'self' in the client
    // (single-user invariant).
    if (ctx.providerAttemptCaller === undefined) {
      throw new TypeError('search_memory_facts requires the actual provider attempt caller');
    }
    if (ctx.providerSessionDeadlineAt === undefined) {
      throw new TypeError('search_memory_facts requires a provider session deadline');
    }
    ctx.signal?.throwIfAborted();
    if (Date.now() >= ctx.providerSessionDeadlineAt) {
      throw new Error('hard_deadline_exceeded');
    }
    const topK = input.topK ?? DEFAULT_FACTS_TOP_K;
    const scopeKey = input.scopeKey ?? null;
    const inputDigest = createHash('sha256')
      .update(JSON.stringify({ query: input.query, topK, scopeKey }))
      .digest('hex');
    const result = await readMemoryFacts(
      input.query,
      {
        topK,
        filters: scopeKey ? { scope_key: scopeKey } : undefined,
      },
      createMem0OpaqueOperationContext({
        db: ctx.db,
        caller: ctx.providerAttemptCaller,
        deadlineAt: new Date(ctx.providerSessionDeadlineAt),
        operationAnchor: `search-memory-facts:${ctx.taskRunId}:${inputDigest}`,
      }),
      readDeps,
    );
    const facts = result.results ?? [];
    return SearchMemoryFactsOutputSchema.parse({ facts, count: facts.length });
  }

  return {
    name: 'search_memory_facts',
    description:
      'Search the Mem0 fact store (pgvector) for learned facts about the user. Read-only attention prior (ADR-0017) — never mutates scheduling or mastery. Optional scopeKey filter; note subject:* drops most learning facts (use topic:* or global).',
    effect: 'read',
    inputSchema: SearchMemoryFactsInputSchema,
    outputSchema: SearchMemoryFactsOutputSchema,
    // Embedding API hit (OpenAI) on every search.
    costClass: 'cheap_llm',
    execute,
    summarize(input, output) {
      return `memory facts · "${input.query.slice(0, 24)}" · ${output.count} hits`;
    },
    // Internal planner-style retrieval, not user-visible.
    mirrorEvent: 'never',
  };
}

export const searchMemoryFactsTool = buildSearchMemoryFactsTool();
