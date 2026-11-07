/** Read-only recall evaluation; model-agreed real labels and synthetic labels stay separate. */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import { runSearchBank } from '@/capabilities/practice/question-bank/tools/bank-search';
import { SearchBankInputSchema } from '@/capabilities/practice/question-bank/tools/bank-search-contract';
import { bankReadRoleForActor } from '@/capabilities/practice/question-bank/tools/read-bank';
import { collectBankSearchReceipt } from '@/capabilities/practice/question-bank/tools/search-bank';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { EvidenceDemandV1 } from '@/kernel/supply-contracts';
import { EMBED_MODEL, embedText } from '@/server/ai/embed';
import { createProviderAttemptLifecycle } from '@/server/ai/provider-attempt-lifecycle';
import { searchBenchmarkActor } from './search-bank-fixture-access';
import {
  assertSearchBenchmarkPaidGate,
  guardSearchBenchmarkEmbedding,
} from './search-bank-paid-gate';

const Gold = z.object({
  consumer: z.enum(['question_preparer', 'copilot']).default('question_preparer'),
  label_tier: z.enum(['lead_judged_synthetic', 'two_model_independent']),
  judged_by: z.string().optional(),
  snapshot_digest: z.string().optional(),
  model_routes: z.array(z.object({ provider: z.string(), model: z.string() })).optional(),
  requests: z
    .array(
      z.object({
        id: z.string().optional(),
        query: z.string().optional(),
        utterance: z.string().optional(),
        origin: z
          .enum(['preparer_tool_query', 'real_utterance', 'design_example'])
          .default('design_example'),
        source_record_digest: z.string().optional(),
        task_kind: z.string().optional(),
        demand: EvidenceDemandV1.optional(),
        ticket_event_id: z.string().optional(),
        class: z.enum(['present', 'absent', 'unknown']).optional(),
        relevant_refs: z.array(z.string()).optional(),
        relevant_ids: z.array(z.string()).optional(),
        corpus_absent: z.boolean().optional(),
        input: z.object(SearchBankInputSchema.shape).strict().optional(),
        easy_ids: z.array(z.string()).optional(),
        easy_refs: z.array(z.string()).optional(),
        template_family_ids: z.array(z.number()).optional(),
      }),
    )
    .min(1),
});

/** Identity metadata only; it neither exports nor hashes raw question text in the report. */
async function bankVersion(db: Db) {
  const rows = await db.execute(`SELECT jsonb_build_object(
    'questions',(SELECT jsonb_agg(jsonb_build_array(id,version,embed_model,embed_version,embed_content_hash,embed_source_revision) ORDER BY id) FROM question),
    'lifecycle',(SELECT jsonb_agg(jsonb_build_array(group_id,current_revision_id,scoring_admission_generation,scoring_admission_state,availability,suspended,withdrawn) ORDER BY group_id) FROM question_group_lifecycle),
    'prior',(SELECT jsonb_agg(jsonb_build_array(revision_id,part_id,prior_version,md5(prior::text)) ORDER BY revision_id,part_id) FROM question_solution_prior),
    'vectors',(SELECT jsonb_agg(jsonb_build_array(revision_id,part_id,facet,idx,embed_model,embed_version,content_hash) ORDER BY revision_id,part_id,facet,idx) FROM question_solution_prior_vector)
  ) AS identity`);
  return canonicalHash(rows[0].identity);
}
async function main() {
  const nas = process.argv.includes('--nas'),
    ftsOnly = process.argv.includes('--fts-only');
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (
    nas
      ? process.env.NODE_ENV !== 'production'
      : !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.port !== '5434' ||
        !target.pathname.startsWith('/loom_dev_')
  )
    throw Error(
      'Writer target must be an isolated local dev database; --nas is migration-operator only',
    );
  if (nas && !/^\/loom_eval_yuk1986_[a-z0-9_]+$/.test(target.pathname))
    throw Error(
      '--nas requires a named loom_eval_yuk1986_* replica; the TEST database loom is forbidden',
    );
  const output = process.env.SEARCH_BENCH_OUTPUT;
  if (!output) throw Error('External SEARCH_BENCH_OUTPUT required');
  mkdirSync(output, { recursive: true });
  const client = postgres(target.toString(), {
    max: 1,
    connection: { default_transaction_read_only: true },
  });
  const db = drizzle(client, { schema }) as Db;
  let guard: ReturnType<typeof guardSearchBenchmarkEmbedding> | null = null;
  try {
    if (process.argv.includes('--snapshot')) {
      const snapshot_digest = await bankVersion(db);
      writeFileSync(
        join(output, 'snapshot.json'),
        JSON.stringify({ snapshot_digest, read_only: true }, null, 2),
      );
      console.log(JSON.stringify({ snapshot_digest, read_only: true }));
      return;
    }
    const goldPath = process.argv[2];
    if (!goldPath || goldPath.startsWith('--')) throw Error('Pass the gold JSON file first');
    const gold = Gold.parse(JSON.parse(readFileSync(goldPath, 'utf8')));
    if (
      gold.label_tier === 'two_model_independent' &&
      (!gold.snapshot_digest || gold.model_routes?.length !== 2)
    )
      throw Error(
        'Real model-agreed gold needs the frozen snapshot and two independent model routes',
      );
    if (
      gold.label_tier === 'two_model_independent' &&
      (!gold.model_routes?.some((r) => r.model === 'deepseek-v4.1-flash') ||
        !gold.model_routes.some((r) => r.model === 'mimo-v2.6-pro'))
    )
      throw Error('Real gold requires independent flash and mimo-v2.6-pro routes');
    for (const q of gold.requests) {
      if (!q.utterance && !q.query) throw Error('Original query or utterance required');
      if (
        q.origin !== 'design_example' &&
        (!q.source_record_digest || !q.class || !q.relevant_refs)
      )
        throw Error('Real utterances require source digest, three-way class and versioned refs');
      if (gold.label_tier === 'lead_judged_synthetic' && q.origin !== 'design_example')
        throw Error('Synthetic labels cannot become real-utterance acceptance');
    }
    if (
      gold.requests.some(
        (q) =>
          q.origin === 'preparer_tool_query' &&
          (gold.consumer !== 'question_preparer' ||
            q.task_kind !== 'QuestionPreparerTask' ||
            !q.demand),
      )
    )
      throw Error('Real preparer queries require their actual task kind and validated ticket');
    const actor = await searchBenchmarkActor(db, gold.consumer);
    if (!ftsOnly && bankReadRoleForActor(actor) === 'restricted')
      throw Error('Answer-access PR absent: no full-vector acceptance');
    process.env.BANK_GAP_EVIDENCE_SECRET = randomBytes(32).toString('hex');
    const cached = new Map<string, number[]>();
    const embed = async (text: string) => {
      if (ftsOnly) throw Error('Free FTS run cannot request an embedding');
      const old = cached.get(text);
      if (old) return old;
      if (EMBED_MODEL !== 'text-embedding-v4' || !process.env.DASHSCOPE_API_KEY)
        throw Error('Confirmed DashScope v4 route required');
      const vector = await embedText(text, {
        caller: 'api',
        db,
        deadlineAt: new Date(Date.now() + 20000),
        createLifecycle: (context) =>
          createProviderAttemptLifecycle({
            ...context,
            db,
            mode: 'off',
            persistAttemptWhenOff: false,
          }),
      });
      cached.set(text, vector);
      return vector;
    };
    if (!ftsOnly) {
      console.log(
        JSON.stringify({
          provider: 'dashscope',
          model: EMBED_MODEL,
          dimensions: 1024,
          endpoint:
            process.env.MEM0_EMBEDDING_BASE_URL ||
            'https://dashscope.aliyuncs.com/compatible-mode/v1',
        }),
      );
      assertSearchBenchmarkPaidGate(output);
      guard = guardSearchBenchmarkEmbedding(output, 0.02);
    } else
      globalThis.fetch = async () => {
        throw Error('Read-only FTS evaluation makes no remote requests');
      };
    const modes = ftsOnly
      ? ['structured_fts']
      : ['current_recall', 'structured_fts', 'content_vector', 'content_prior_vector'];
    const rows: Array<{
      mode: string;
      index: number;
      origin: string;
      status: string;
      label: string;
      hits?: string[];
      recall_at_5?: number | null;
      precision_at_5?: number;
      easy_recall_at_5?: number | null;
      empty?: boolean;
      template_family_ids?: number[];
    }> = [];
    let frozen = '';
    await db.transaction(
      async (tx) => {
        const connection = tx as unknown as Db;
        frozen = await bankVersion(connection);
        if (gold.snapshot_digest && gold.snapshot_digest !== frozen)
          throw Error('Gold bank version differs from this frozen replica');
        for (const mode of modes)
          for (let index = 0; index < gold.requests.length; index++) {
            const q = gold.requests[index],
              label = q.class ?? (q.corpus_absent ? 'absent' : 'present');
            const record = { mode, index, origin: q.origin, label };
            if (label === 'unknown') {
              rows.push({ ...record, status: 'UNKNOWN_EXCLUDED' });
              continue;
            }
            const refs = q.relevant_refs ?? q.relevant_ids ?? [],
              byRef = q.relevant_refs !== undefined;
            if (new Set(refs).size !== refs.length || (label === 'absent') !== (refs.length === 0))
              throw Error('Inconsistent gold class/ref set');
            const input = SearchBankInputSchema.parse({
              ...q.input,
              query: q.utterance ?? q.query,
              page_size: 5,
            });
            if (!input.query) throw Error('New quality query required');
            let candidates: Array<{ id: string; ref: string | null }>;
            if (mode === 'current_recall') {
              if (input.filters?.terms?.length || input.filters?.history || input.like_ref) {
                rows.push({ ...record, status: 'BASELINE_UNSUPPORTED_INPUT' });
                continue;
              }
              const result = await runSearchBank(
                connection,
                {
                  form: 'new',
                  query: input.query,
                  limit: 5,
                  scope: { ...input.filters, draft_state: 'active', admission_state: 'admitted' },
                },
                { publicOnly: false, embedFn: embed },
              );
              candidates = result.hits.map((h) => ({ id: h.question_id, ref: h.ref }));
            } else {
              const receipt = await collectBankSearchReceipt(
                {
                  db: connection,
                  taskRunId: `read-only-quality-${mode}-${index}`,
                  callerActor: actor,
                  supplyDemand: q.demand,
                  ticketEventId: q.ticket_event_id,
                },
                input,
                {
                  embedFn: embed,
                  vectors:
                    mode === 'structured_fts'
                      ? 'off'
                      : mode === 'content_vector'
                        ? 'content'
                        : 'prior',
                },
              );
              candidates = receipt.output.hits.slice(0, 5);
            }
            const hits = candidates.map((h) => (byRef ? (h.ref ?? '') : h.id)),
              relevant = new Set(refs),
              tp = hits.filter((id) => relevant.has(id)).length,
              easy = q.easy_refs ?? q.easy_ids;
            rows.push({
              ...record,
              status: 'SCORED',
              hits,
              recall_at_5: refs.length ? tp / refs.length : null,
              precision_at_5: tp / 5,
              easy_recall_at_5: easy?.length
                ? hits.filter((id) => easy.includes(id)).length / easy.length
                : null,
              empty: hits.length === 0,
              template_family_ids: q.template_family_ids,
            });
            guard?.assertHealthy();
            writeFileSync(join(output, 'quality-rows.json'), JSON.stringify(rows, null, 2));
          }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
    const summaries = ['preparer_tool_query', 'real_utterance', 'design_example'].flatMap(
      (origin) =>
        modes.map((mode) => {
          const group = rows.filter((r) => r.origin === origin && r.mode === mode),
            scored = group.filter((r) => r.status === 'SCORED'),
            absent = scored.filter((r) => r.label === 'absent'),
            empty = scored.filter((r) => r.empty);
          return {
            origin,
            mode,
            n: group.length,
            scored: scored.length,
            unknown: group.filter((r) => r.status === 'UNKNOWN_EXCLUDED').length,
            baseline_unsupported: group.filter((r) => r.status === 'BASELINE_UNSUPPORTED_INPUT')
              .length,
            corpus_present: scored.filter((r) => r.label === 'present').length,
            corpus_absent: absent.length,
            corpus_absent_fraction: scored.length ? absent.length / scored.length : null,
            recall_at_5: mean(
              scored.flatMap((r) => (typeof r.recall_at_5 === 'number' ? [r.recall_at_5] : [])),
            ),
            precision_at_5: mean(scored.map((r) => r.precision_at_5 ?? 0)),
            easy_recall_at_5: mean(
              scored.flatMap((r) =>
                typeof r.easy_recall_at_5 === 'number' ? [r.easy_recall_at_5] : [],
              ),
            ),
            absent_empty_rate: mean(absent.map((r) => Number(r.empty))),
            no_result_precision: empty.length
              ? empty.filter((r) => r.label === 'absent').length / empty.length
              : null,
            absence_detection_accuracy: mean(
              scored.map((r) => Number(r.empty === (r.label === 'absent'))),
            ),
          };
        }),
    );
    const summary = {
      consumer: gold.consumer,
      actor,
      product_consumer_role_measured: actor.kind === 'agent',
      label_tier: gold.label_tier,
      snapshot_digest: frozen,
      read_only: true,
      complete_ablation: !ftsOnly,
      precision_definition: 'TP/5; unknown requests excluded, not negatives',
      no_result_definitions:
        'absent_empty_rate=empty/absent; no_result_precision=absent/empty; absence_detection_accuracy=correct empty/nonempty over known classes',
      baseline_note:
        'current_recall is existing recall without retired model verification; unsupported new filters reported explicitly',
      template_bias:
        gold.label_tier === 'lead_judged_synthetic'
          ? 'Template families inflate apparent quality; mechanism evidence only'
          : null,
      root_overconfidence: 'NOT_MEASURED: reconcile real learner/preparer decisions separately',
      summaries,
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
