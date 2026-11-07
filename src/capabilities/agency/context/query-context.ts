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
import { readLegacyFacts } from './legacy-facts';
import { readMemoryBriefNote } from './memory-brief';
import { Topic } from './topic-contract';

const DEFAULT_FACTS_TOP_K = 10;

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
  topicKeys: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe(
      'Read full digest topics (facts with ids, memory_kind, evidence_ids) for these topic keys. Use the topic index to choose; at most 5 per call.',
    ),
  legacyFacts: z
    .object({
      afterId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .optional()
    .describe(
      'Page the pre-digest legacy fact layer (mem0), ordered by id ascending. Pass the previous next_cursor as afterId; limit is 1-50 (default 20).',
    ),
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
  topics: z
    .object({
      version: z.number().int(),
      as_of: z.string().nullable(),
      topics: z.array(Topic),
      missing_topic_keys: z.array(z.string()).default([]),
    })
    .optional(),
  legacy_facts: z
    .object({
      facts: z.array(
        z.object({
          id: z.string(),
          body: z.string(),
          memory_kind: z.enum(['preference', 'habit', 'weakness', 'event']),
          evidence_ids: z.array(z.string()),
        }),
      ),
      total: z.number().int().nonnegative(),
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
    })
    .optional(),
});

type QueryContextInput = z.infer<typeof QueryContextInputSchema>;
type QueryContextOutput = z.infer<typeof QueryContextOutputSchema>;

export function buildQueryContextTool(
  opts: { memoryFactory?: MemoryReadClientFactory } = {},
): DomainTool<QueryContextInput, QueryContextOutput> {
  const readDeps = opts.memoryFactory ? { createClient: opts.memoryFactory } : undefined;

  async function execute(ctx: ToolContext, input: QueryContextInput): Promise<QueryContextOutput> {
    const explicitScope = input.scopeKey !== undefined;
    // A topic/legacy page read asks for one slice; it must not drag the whole
    // default global brief (prose digest) back into the prompt.
    const includeBrief =
      explicitScope || (input.topicKeys === undefined && input.legacyFacts === undefined);
    const scopeKey = input.scopeKey ?? 'global:digest';
    let read: Awaited<ReturnType<typeof readMemoryBriefNote>> | null = includeBrief
      ? await readMemoryBriefNote(ctx.db, scopeKey)
      : null;
    const digestRead = await readTopics(ctx.db);
    const { digest } = digestRead;
    const withheld = withdrawnTopicEvidence(digest);
    if (
      read?.note &&
      [
        ...read.note.recent_week_evidence_ids,
        ...read.note.recent_months_evidence_ids,
        ...read.note.long_term_evidence_ids,
      ].some((id) => withheld.has(id))
    )
      read = { note: null, freshness: { ...read.freshness, state: 'missing' } };
    const scoped = digest.topics.filter(
      (t) => scopeKey === 'global:digest' || scopeKey === 'global' || t.scope_key === scopeKey,
    );
    const scopedText = includeBrief
      ? scoped.map((t) => `${t.name}：${t.facts.map((f) => f.body).join('；')}`).join('\n')
      : '';
    if (includeBrief && scopedText && read && !read.note)
      read = await readMemoryBriefNote(ctx.db, 'global:digest');
    const brief =
      includeBrief && read
        ? {
            note: read.note
              ? {
                  scope_key: read.note.scope_key,
                  recent_week_md: scopedText || read.note.recent_week_md,
                  // One body, one field: scoped digest prose used to be copied into
                  // recent_week_md and long_term_md, doubling a query_context read.
                  recent_months_md: scopedText
                    ? ''
                    : read.note.scope_key === scopeKey
                      ? read.note.recent_months_md
                      : '',
                  long_term_md:
                    scopeKey === 'global:digest' || read.note.scope_key !== scopeKey
                      ? ''
                      : read.note.long_term_md,
                  long_term_freshness_score: read.note.long_term_freshness_score,
                  refreshed_at: iso(read.note.refreshed_at),
                  version: read.note.version,
                }
              : null,
            freshness: read.freshness,
          }
        : null;

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
      const list = (result.results ?? [])
        .filter((f) => !withheld.has(String(f.metadata?.event_id ?? '')))
        .map((f) => ({
          id: f.id,
          memory: f.memory,
          score: f.score,
        }));
      facts = { facts: list, count: list.length };
    }

    const topicsRead = input.topicKeys?.length
      ? {
          version: digestRead.version,
          as_of: digest.as_of,
          topics: digest.topics.filter((topic) => input.topicKeys?.includes(topic.key)),
          missing_topic_keys: input.topicKeys.filter(
            (key) => !digest.topics.some((topic) => topic.key === key),
          ),
        }
      : undefined;

    let legacyFactsRead: QueryContextOutput['legacy_facts'];
    if (input.legacyFacts) {
      const all = await readLegacyFacts(ctx.db);
      const afterId = input.legacyFacts.afterId;
      const remaining = afterId ? all.filter((fact) => fact.id > afterId) : all;
      const limit = input.legacyFacts.limit ?? 20;
      const page = remaining.slice(0, limit);
      legacyFactsRead = {
        facts: page.map((fact) => ({
          id: fact.id,
          body: fact.body,
          memory_kind: fact.memory_kind,
          evidence_ids: fact.evidence_ids,
        })),
        total: all.length,
        has_more: remaining.length > page.length,
        next_cursor: page.at(-1)?.id ?? null,
      };
    }

    return QueryContextOutputSchema.parse({
      brief,
      facts,
      ...(topicsRead ? { topics: topicsRead } : {}),
      ...(legacyFactsRead ? { legacy_facts: legacyFactsRead } : {}),
    });
  }

  return {
    name: 'query_context',
    description:
      "Read the learner Context warm layer: topic facts (topicKeys), the Dreaming-maintained memory brief at a scope plus, at depth='deep', Mem0 facts matched by `query`, and the pre-digest legacy facts page. Topic-only or legacy-only reads skip the default brief. Read-only attention prior (ADR-0017) — never mutates scheduling or mastery. The startup segment already carries the global brief; use this to drill into a scope or read a topic's full facts.",
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
      const topics = input.topicKeys?.length
        ? ` · ${output.topics?.topics.length ?? 0}/${input.topicKeys.length} topics`
        : '';
      const legacy = input.legacyFacts
        ? ` · legacy ${output.legacy_facts?.facts.length ?? 0}/${output.legacy_facts?.total ?? 0}`
        : '';
      return `context · ${input.scopeKey ?? 'global'} · ${brief}${facts}${topics}${legacy}`;
    },
    // Same policy the brief read always had: a user-facing copilot lookup shows
    // up as a step; coach/dreaming callers stay invisible either way.
    mirrorEvent: 'when_user_visible',
  };
}

export const queryContextTool = buildQueryContextTool();
