// YUK-203 U4 / L-memtool — `search_memory_facts` DomainTool.
//
// First agent-layer tool over the Mem0 fact layer (pgvector). Thin wrapper on
// `MemoryClient.search()` (src/server/memory/client.ts:179-186); orthogonal to
// the Dreaming-maintained `query_memory_brief` note layer (context-readers.ts).
//
// Governance (docs/design/2026-06-04-u0-decisions.md D7②): granted to
// coach / dreaming / copilot ONLY. Per ADR-0017 memory is an attention prior,
// not a source of truth — this tool only READS facts; it never mutates due /
// mastery / FSRS and never biases judging. `mirrorEvent: 'never'` keeps the
// internal retrieval out of the user-visible event stream.

import { type MemoryClient, createMemoryClient } from '@/server/memory/client';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

export const SearchMemoryFactsInputSchema = z.object({
  query: z.string().min(1).describe('Natural-language retrieval query for the Mem0 fact store.'),
  topK: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Max facts to return (1-20). Defaults to the Mem0 client default when omitted.'),
  // ADR-0017 fixes 5 scope prefixes: `global` / `subject:*` / `topic:*` /
  // `mistake_cluster:*` / `meta:orchestrator_self`. The value is matched against
  // a fact's `affected_scopes` via `{ contains: scopeKey }` (client.ts:181-183).
  //
  // TRAP (memory map bullet 8): attempt/review-derived learning facts carry ONLY
  // `global` + `topic:*` scopes — never `subject:X`. Passing a `subject:wenyan`
  // scopeKey therefore silently drops nearly all learning facts. Prefer `topic:*`
  // or leave unset (global) for learning retrieval; reserve `subject:*` for facts
  // you know were tagged at subject scope.
  scopeKey: z
    .string()
    .optional()
    .describe(
      'Optional scope filter (one of: global, subject:*, topic:*, mistake_cluster:*, meta:orchestrator_self). ' +
        'WARNING: attempt/review facts are tagged global+topic:* only, never subject:* — a subject:* filter drops most learning facts.',
    ),
});
export type SearchMemoryFactsInput = z.infer<typeof SearchMemoryFactsInputSchema>;

// Mem0 `SearchResult` has no project Zod schema (memory map bullet 1). Define a
// minimal typed projection instead of `z.unknown()` so the output is
// summarizable and the LLM sees a stable shape. `.passthrough()` keeps any extra
// MemoryItem fields (hash / createdAt / metadata) without pinning them.
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

// Inject seam (plan §62 / client DI seam at client.ts:143-161). The memory
// client construction needs env (XIAOMI/OPENAI keys) and is NOT carried on
// ToolContext (types.ts:38-44), so we self-construct lazily via a factory. Tests
// pass a stub factory so unit tests never touch real env / pgvector.
export type MemoryClientFactory = () => MemoryClient;

const defaultMemoryClientFactory: MemoryClientFactory = () => createMemoryClient();

export function buildSearchMemoryFactsTool(
  opts: { memoryFactory?: MemoryClientFactory } = {},
): DomainTool<SearchMemoryFactsInput, SearchMemoryFactsOutput> {
  const memoryFactory = opts.memoryFactory ?? defaultMemoryClientFactory;

  async function execute(
    _ctx: ToolContext,
    input: SearchMemoryFactsInput,
  ): Promise<SearchMemoryFactsOutput> {
    const client = memoryFactory();
    // `user_id` is forced to 'self' inside the client wrapper (client.ts:184) —
    // single-user invariant. `scopeKey` is threaded through the documented
    // `{ contains }` filter shape (client.ts:181-183).
    const result = await client.search(input.query, {
      topK: input.topK,
      filters: input.scopeKey ? { scope_key: input.scopeKey } : undefined,
    });
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
    // Embedding API hit (OpenAI) on every search — memory map bullet 4.
    costClass: 'cheap_llm',
    execute,
    summarize(input, output) {
      return `memory facts · "${input.query.slice(0, 24)}" · ${output.count} hits`;
    },
    // Internal planner-style retrieval, not user-visible — memory map bullet 4.
    mirrorEvent: 'never',
  };
}

export const searchMemoryFactsTool = buildSearchMemoryFactsTool();
