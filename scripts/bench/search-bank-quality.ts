/** Human-marked retrieval evaluation. An unapproved writer proposal is never scored as gold. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { runBankSearchV3 } from '@/capabilities/practice/question-bank/tools/search-bank';
import { runSearchBank } from '@/capabilities/practice/question-bank/tools/bank-search';
import { bankReadRoleForActor } from '@/capabilities/practice/question-bank/tools/read-bank';
import {
  SearchBankInputSchema,
  type SearchBankInput,
} from '@/capabilities/practice/question-bank/tools/bank-search-contract';
import { embedText } from '@/server/ai/embed';
import {
  assertSearchBenchmarkPaidGate,
  guardSearchBenchmarkEmbedding,
} from './search-bank-paid-gate';

async function main() {
  const goldPath = process.argv[2];
  if (!goldPath) throw Error('Pass the human-approved gold JSON path');
  const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as {
    label_tier?: string;
    judged_by?: string;
    human_marked_by: string | null;
    human_approved_at: string | null;
    requests: Array<{
      query: string;
      input?: SearchBankInput;
      relevant_ids: string[];
      corpus_absent: boolean;
      easy_ids?: string[];
      template_family_ids?: number[];
    }>;
  };
  if (
    gold.label_tier !== 'lead_judged_synthetic' &&
    (!gold.human_marked_by || !gold.human_approved_at)
  )
    throw Error('Human gold approval missing; writer-proposed labels cannot satisfy acceptance');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const nas = process.argv.includes('--nas');
  if (
    nas
      ? process.env.NODE_ENV !== 'production'
      : !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.port !== '5434' ||
        !url.pathname.startsWith('/loom_dev_')
  )
    throw Error('Refusing a non-isolated writer target');
  const output = process.env.SEARCH_BENCH_OUTPUT;
  if (!output) throw Error('External SEARCH_BENCH_OUTPUT required');
  const ftsOnly = process.argv.includes('--fts-only');
  const actor = { kind: 'agent' as const, ref: 'copilot' };
  if (!ftsOnly && bankReadRoleForActor(actor) === 'restricted')
    throw Error('Answer-access PR absent; full-vector quality cannot be claimed');
  mkdirSync(output, { recursive: true });
  if (!ftsOnly) assertSearchBenchmarkPaidGate(output);
  const guard = ftsOnly ? null : guardSearchBenchmarkEmbedding(output, 0.02);
  if (ftsOnly)
    globalThis.fetch = async () => {
      throw Error('Free FTS run must not send a remote request');
    };
  const client = postgres(url.toString(), { max: 5 }),
    db = drizzle(client, { schema }) as Db;
  const rows: Array<Record<string, unknown>> = [];
  const modes = (
    ftsOnly
      ? ['structured_fts']
      : ['current_recall', 'structured_fts', 'content_vector', 'content_prior_vector']
  ) as Array<'current_recall' | 'structured_fts' | 'content_vector' | 'content_prior_vector'>;
  const vectors = new Map<string, number[]>();
  try {
    await client.begin(async (locker) => {
      await locker.unsafe(
        'LOCK TABLE question, question_group_lifecycle, question_solution_prior, question_solution_prior_vector IN SHARE MODE NOWAIT',
      );
      for (const mode of modes)
        for (let i = 0; i < gold.requests.length; i++) {
          const q = gold.requests[i],
            input = SearchBankInputSchema.parse({ ...q.input, query: q.query, page_size: 5 });
          if (
            new Set(q.relevant_ids).size !== q.relevant_ids.length ||
            q.corpus_absent !== (q.relevant_ids.length === 0)
          )
            throw Error('Gold labels are internally inconsistent');
          let hits: string[];
          if (mode === 'current_recall') {
            if (input.filters?.terms?.length || input.filters?.history || input.like_ref) {
              rows.push({
                mode,
                index: i,
                status: 'UNSUPPORTED_BASELINE_FILTER',
                note: 'not silently dropped from baseline',
              });
              continue;
            }
            const result = await runSearchBank(
              db,
              {
                form: 'new',
                query: q.query,
                limit: 5,
                scope: { ...input.filters, draft_state: 'active', admission_state: 'admitted' },
              },
              {
                publicOnly: false,
                embedFn: async (text) => {
                  const cached = vectors.get(text);
                  if (cached) return cached;
                  const vector = await embedText(text, {
                    db,
                    caller: 'api',
                    deadlineAt: new Date(Date.now() + 20_000),
                  });
                  vectors.set(text, vector);
                  return vector;
                },
              },
            );
            hits = result.hits.map((h) => h.question_id);
          } else {
            const result = await runBankSearchV3(
              { db, taskRunId: `quality-${mode}-${i}`, callerActor: actor },
              input,
              mode === 'structured_fts'
                ? { vectors: 'off' }
                : mode === 'content_vector'
                  ? { vectors: 'content' }
                  : undefined,
            );
            hits = result.hits.map((h) => h.id);
          }
          const relevant = new Set(q.relevant_ids),
            tp = hits.filter((id) => relevant.has(id)).length;
          rows.push({
            mode,
            index: i,
            status: 'scored',
            hits,
            relevant_count: relevant.size,
            corpus_absent: q.corpus_absent,
            recall_at_5: relevant.size ? tp / relevant.size : null,
            easy_recall_at_5: q.easy_ids?.length
              ? hits.filter((id) => q.easy_ids?.includes(id)).length / q.easy_ids.length
              : null,
            template_family_ids: q.template_family_ids,
            root_easy_selection: 'NOT_MEASURED',
            precision_at_5: tp / 5,
            returned_precision: hits.length ? tp / hits.length : 0,
            no_result_correct: q.corpus_absent ? hits.length === 0 : null,
          });
          guard?.assertHealthy();
          writeFileSync(join(output, 'quality-rows.json'), JSON.stringify(rows, null, 2));
        }
    });
    const mean = (values: number[]) =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const summary = {
      complete_ablation: !ftsOnly,
      unrun_modes: ftsOnly ? ['current_recall', 'content_vector', 'content_prior_vector'] : [],
      label_tier: gold.label_tier ?? 'human_real',
      synthetic_template_bias:
        gold.label_tier === 'lead_judged_synthetic'
          ? 'Template-family recall can be inflated; mechanism evidence only, not real acceptance'
          : null,
      gold_author: gold.human_marked_by ?? gold.judged_by,
      gold_approved_at: gold.human_approved_at,
      n: gold.requests.length,
      corpus_absent_fraction:
        gold.requests.filter((r) => r.corpus_absent).length / gold.requests.length,
      baseline_note:
        'current_recall measures existing retrieval, not retired v2 model-verification decisions',
      root_overconfidence:
        'NOT_MEASURED: needs separate real Copilot judgments reconciled with human labels',
      modes: modes.map((mode) => {
        const scored = rows.filter((r) => r.mode === mode && r.status === 'scored');
        return {
          mode,
          n: scored.length,
          unsupported: rows.filter((r) => r.mode === mode && r.status !== 'scored').length,
          recall_at_5: mean(
            scored.flatMap((r) => (typeof r.recall_at_5 === 'number' ? [r.recall_at_5] : [])),
          ),
          precision_at_5: mean(scored.map((r) => Number(r.precision_at_5))),
          no_result_accuracy: mean(
            scored.flatMap((r) =>
              typeof r.no_result_correct === 'boolean' ? [Number(r.no_result_correct)] : [],
            ),
          ),
        };
      }),
    };
    writeFileSync(join(output, 'quality-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    guard?.restore();
    await client.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
