import { readTopics, withdrawnTopicEvidence } from './topics';
// `query_context` — the merged Context warm-layer read (YUK-1794 B1). One tool
// over the two layers that both still exist pre-C slice:
//   depth 'summary' → brief layer only (Dreaming-maintained memory_brief_note);
//   depth 'deep'    → brief + Mem0 fact layer (pgvector, embedding query).
// The brief leg goes through `context/memory-brief`, the one read semantics
// (row + purpose-current gate + freshness). Governance unchanged: attention
// prior only (ADR-0017), never mutates scheduling/mastery; the scopeKey
// subject:* trap stays documented on the input schema.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  type MemoryReadClientFactory,
  createMem0OpaqueOperationContext,
  readMemoryFacts,
} from '@/server/ai/mem0/read';
import { readMemoryBriefNote } from './memory-brief';

const DEFAULT_FACTS_TOP_K = 10;
const GLOBAL_DIGEST_SCOPE = 'global:digest';

/** `global:digest` is the brief scope, not a fact scope. Filtering on it matches nothing. */
function factScopeFilters(scopeKey: string): { scope_key: string } | undefined {
  if (scopeKey === GLOBAL_DIGEST_SCOPE) return undefined;
  return { scope_key: scopeKey };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

const QueryContextInputSchema = z.object({
  scopeKey: z
    .string()
    .optional()
    .describe(
      'Optional scope. Defaults to global:digest: the global brief, and fact search is not filtered by scope. Pass global, subject:*, topic:*, mistake_cluster:*, or meta:orchestrator_self to filter. WARNING: attempt/review facts carry only global and topic:* scopes, never subject:* — a subject:* filter drops most learning facts.',
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
    const scopeKey = input.scopeKey ?? GLOBAL_DIGEST_SCOPE;
    let read = await readMemoryBriefNote(ctx.db, scopeKey);
    const { digest } = await readTopics(ctx.db);
    const withheld = withdrawnTopicEvidence(digest);
    if (
      read.note &&
      [
        ...read.note.recent_week_evidence_ids,
        ...read.note.recent_months_evidence_ids,
        ...read.note.long_term_evidence_ids,
      ].some((id) => withheld.has(id))
    )
      read = { note: null, freshness: { ...read.freshness, state: 'missing' } };
    const scoped = digest.topics.filter(
      (t) => scopeKey === GLOBAL_DIGEST_SCOPE || scopeKey === 'global' || t.scope_key === scopeKey,
    );
    const scopedText = scoped
      .map((t) => `${t.name}：${t.facts.map((f) => f.body).join('；')}`)
      .join('\n');
    if (scopedText && !read.note) read = await readMemoryBriefNote(ctx.db, GLOBAL_DIGEST_SCOPE);
    const brief = {
      note: read.note
        ? {
            scope_key: read.note.scope_key,
            recent_week_md: scopedText || read.note.recent_week_md,
            recent_months_md: scopedText ? '' : read.note.recent_months_md,
            long_term_md:
              scopedText || (scopeKey === GLOBAL_DIGEST_SCOPE ? '' : read.note.long_term_md),
            long_term_freshness_score: read.note.long_term_freshness_score,
            refreshed_at: iso(read.note.refreshed_at),
            version: read.note.version,
          }
        : null,
      freshness: read.freshness,
    };

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
      const factFilters = factScopeFilters(scopeKey);
      const inputDigest = createHash('sha256')
        .update(
          JSON.stringify({
            query,
            topK: DEFAULT_FACTS_TOP_K,
            scopeKey: factFilters?.scope_key ?? null,
          }),
        )
        .digest('hex');
      const result = await readMemoryFacts(
        query,
        {
          topK: DEFAULT_FACTS_TOP_K,
          filters: factFilters,
        },
        createMem0OpaqueOperationContext({
          db: ctx.db,
          caller: ctx.providerAttemptCaller,
          deadlineAt: new Date(ctx.providerSessionDeadlineAt),
          operationAnchor: `query-context:${ctx.taskRunId}:${inputDigest}`,
        }),
        readDeps,
      );
      const list = (result.results ?? [])
        .filter((f) => !withheld.has(String(f.metadata?.event_id ?? '')))
        .map((f) => ({
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
      "Read the learner Context warm layer: the Dreaming-maintained memory brief at a scope plus, at depth='deep', Mem0 facts matched by `query`. Read-only attention prior (ADR-0017) — never mutates scheduling or mastery. A failed fact search is a tool error, not zero facts. The startup segment already carries the global brief; use this to drill into a scope.",
    effect: 'read',
    inputSchema: QueryContextInputSchema,
    outputSchema: QueryContextOutputSchema,
    // The default summary depth is a pure local read; depth=deep still spends one
    // embedding call per query (documented on the input schema).
    costClass: 'local',
    execute,
    summarize(input, output) {
      const brief = output.brief?.note
        ? `brief v${output.brief.note.version} ${output.brief.freshness.state}`
        : `brief ${output.brief?.freshness.state ?? 'missing'}`;
      const facts = output.facts ? ` · ${output.facts.count} facts` : '';
      return `context · ${input.scopeKey ?? GLOBAL_DIGEST_SCOPE} · ${brief}${facts}`;
    },
    // Same policy the brief read always had: a user-facing copilot lookup shows
    // up as a step; coach/dreaming callers stay invisible either way.
    mirrorEvent: 'when_user_visible',
  };
}

export const queryContextTool = buildQueryContextTool();
