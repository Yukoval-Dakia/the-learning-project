// `query_context` — the merged warm-layer read (YUK-1794 B1), replacing
// `query_memory_brief` + `search_memory_facts`. Read-side aggregates the two
// layers that both still exist pre-C slice:
//   depth 'summary' → brief layer only (Dreaming-maintained memory_brief_note);
//   depth 'deep'    → brief + Mem0 fact layer (pgvector, embedding query).
// Governance unchanged: attention prior only (ADR-0017), never mutates
// scheduling/mastery; scopeKey trap from the old tool is preserved in docs.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { memory_brief_note } from '@/db/schema';
import { briefPurposeCurrent } from '@/kernel/read-models/purpose-change';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  type MemoryReadClientFactory,
  createMem0OpaqueOperationContext,
  readMemoryFacts,
} from '@/server/ai/mem0/read';

const DEFAULT_FACTS_TOP_K = 10;
export const MEMORY_BRIEF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

const QueryContextInputSchema = z.object({
  scopeKey: z
    .string()
    .optional()
    .describe(
      'Optional scope filter (global, subject:*, topic:*, mistake_cluster:*, meta:orchestrator_self). Defaults to global. WARNING: attempt/review facts carry only global + topic:* scopes, never subject:* — a subject:* filter drops most learning facts.',
    ),
  depth: z
    .enum(['summary', 'deep'])
    .optional()
    .describe(
      'summary = brief layer only (default, no provider call). deep = brief + Mem0 fact layer; requires `query` and spends one embedding call.',
    ),
  query: z
    .string()
    .min(1)
    .optional()
    .describe('Natural-language retrieval query for the fact layer (depth=deep only).'),
});

const BriefNoteSchema = z.object({
  scope_key: z.string(),
  recent_week_md: z.string(),
  recent_months_md: z.string(),
  long_term_md: z.string(),
  long_term_freshness_score: z.number().nullable(),
  refreshed_at: z.string().nullable(),
  version: z.number().int(),
});

const QueryContextOutputSchema = z.object({
  brief: z
    .object({
      note: BriefNoteSchema.nullable(),
      freshness: z.object({
        state: z.enum(['fresh', 'stale', 'missing']),
        age_ms: z.number().int().nonnegative().nullable(),
        stale_after_ms: z.number().int().positive(),
      }),
    })
    .nullable(),
  facts: z
    .object({
      facts: z.array(
        z.object({
          id: z.string().optional(),
          memory: z.string().optional(),
          score: z.number().optional(),
        }),
      ),
      count: z.number(),
    })
    .nullable(),
});

type QueryContextInput = z.infer<typeof QueryContextInputSchema>;
type QueryContextOutput = z.infer<typeof QueryContextOutputSchema>;

export function buildQueryContextTool(
  opts: { memoryFactory?: MemoryReadClientFactory } = {},
): DomainTool<QueryContextInput, QueryContextOutput> {
  const readDeps = opts.memoryFactory ? { createClient: opts.memoryFactory } : undefined;

  async function execute(ctx: ToolContext, input: QueryContextInput): Promise<QueryContextOutput> {
    const scopeKey = input.scopeKey ?? 'global';
    const [note] = await ctx.db
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, scopeKey))
      .limit(1);
    const brief =
      !note || !(await briefPurposeCurrent(ctx.db, scopeKey, note.version))
        ? {
            note: null,
            freshness: {
              state: 'missing' as const,
              age_ms: null,
              stale_after_ms: MEMORY_BRIEF_STALE_AFTER_MS,
            },
          }
        : (() => {
            const ageMs = note.refreshed_at
              ? Math.max(0, Date.now() - note.refreshed_at.getTime())
              : null;
            return {
              note: {
                scope_key: note.scope_key,
                recent_week_md: note.recent_week_md,
                recent_months_md: note.recent_months_md,
                long_term_md: note.long_term_md,
                long_term_freshness_score: note.long_term_freshness_score ?? null,
                refreshed_at: iso(note.refreshed_at),
                version: note.version,
              },
              freshness: {
                state: (ageMs === null || ageMs >= MEMORY_BRIEF_STALE_AFTER_MS
                  ? 'stale'
                  : 'fresh') as 'fresh' | 'stale',
                age_ms: ageMs,
                stale_after_ms: MEMORY_BRIEF_STALE_AFTER_MS,
              },
            };
          })();

    let facts: QueryContextOutput['facts'] = null;
    if (input.depth === 'deep') {
      const query = input.query ?? scopeKey;
      if (ctx.providerAttemptCaller === undefined) {
        throw new TypeError('query_context depth=deep requires the actual provider attempt caller');
      }
      if (ctx.providerSessionDeadlineAt === undefined) {
        throw new TypeError('query_context depth=deep requires a provider session deadline');
      }
      ctx.signal?.throwIfAborted();
      if (Date.now() >= ctx.providerSessionDeadlineAt) {
        throw new Error('hard_deadline_exceeded');
      }
      const inputDigest = createHash('sha256')
        .update(JSON.stringify({ query, topK: DEFAULT_FACTS_TOP_K, scopeKey }))
        .digest('hex');
      const result = await readMemoryFacts(
        query,
        {
          topK: DEFAULT_FACTS_TOP_K,
          filters: scopeKey ? { scope_key: scopeKey } : undefined,
        },
        createMem0OpaqueOperationContext({
          db: ctx.db,
          caller: ctx.providerAttemptCaller,
          deadlineAt: new Date(ctx.providerSessionDeadlineAt),
          operationAnchor: `query-context:${ctx.taskRunId}:${inputDigest}`,
        }),
        readDeps,
      );
      const list = (result.results ?? []).map((f) => ({
        id: f.id,
        memory: f.memory,
        score: f.score,
      }));
      facts = { facts: list, count: list.length };
    }

    return QueryContextOutputSchema.parse({ brief, facts });
  }

  return {
    name: 'query_context',
    description:
      "Read the learner Context warm layer: the Dreaming-maintained memory brief at a scope plus, at depth='deep', Mem0 facts matched by `query`. Read-only attention prior (ADR-0017) — never mutates scheduling or mastery. The startup segment already carries the global brief; use this to drill into a scope.",
    effect: 'read',
    inputSchema: QueryContextInputSchema,
    outputSchema: QueryContextOutputSchema,
    // depth=deep spends an embedding call per query.
    costClass: 'cheap_llm',
    execute,
    summarize(input, output) {
      const brief = output.brief?.note
        ? `brief v${output.brief.note.version} ${output.brief.freshness.state}`
        : `brief ${output.brief?.freshness.state ?? 'missing'}`;
      const facts = output.facts ? ` · ${output.facts.count} facts` : '';
      return `context · ${input.scopeKey ?? 'global'} · ${brief}${facts}`;
    },
    mirrorEvent: 'when_user_visible',
  };
}

export const queryContextTool = buildQueryContextTool();
