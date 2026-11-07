/** Product tool boundary benchmark. No learner/model turn or question write is performed. */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  assertSearchBenchmarkPaidGate,
  guardSearchBenchmarkEmbedding,
} from './search-bank-paid-gate';

const prompts = [
  '给我找两道一元二次方程的题',
  '我想练一次函数，有简单点的题吗',
  '概率有没有掷骰子的题',
  '来一道一元二次方程判别式的题',
  '帮我找道一次函数的题做做',
];
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const target = new URL(url);
  const nas = process.argv.includes('--nas');
  if (
    !nas &&
    (!['127.0.0.1', 'localhost'].includes(target.hostname) ||
      target.port !== '5434' ||
      !target.pathname.startsWith('/loom_dev_'))
  )
    throw new Error('Writer mode permits only an isolated local dev database');
  if (nas && process.env.NODE_ENV !== 'production')
    throw new Error('--nas is for the migration operator inside the production worker environment');
  const model = process.env.MEM0_EMBEDDING_MODEL?.trim() || 'text-embedding-v4';
  if (model !== 'text-embedding-v4' || !process.env.DASHSCOPE_API_KEY)
    throw new Error(
      'Requires the confirmed DashScope v4 route/key; no alternate embedding model is evidence',
    );
  const output = process.env.SEARCH_BENCH_OUTPUT;
  if (!output) throw new Error('SEARCH_BENCH_OUTPUT must name an external evidence directory');
  mkdirSync(output, { recursive: true });
  if (existsSync(join(output, 'requests.jsonl')))
    throw Error('Fixed cohort already started; do not rerun or overwrite acceptance samples');
  assertSearchBenchmarkPaidGate(output);
  const budgetGuard = guardSearchBenchmarkEmbedding(output, 0.05);
  const client = postgres(url, { max: 12 });
  const db = drizzle(client, { schema }) as Db;
  const { searchBankTool, clearBankQueryCache } = await import(
    '@/capabilities/practice/question-bank/tools/search-bank'
  );
  const { bankReadRoleForActor } = await import(
    '@/capabilities/practice/question-bank/tools/read-bank'
  );
  const actor = { kind: 'agent' as const, ref: 'copilot' };
  if (bankReadRoleForActor(actor) === 'restricted')
    throw Error(
      'Copilot answer-access PR is not present: refusing a FTS-only substitute for full-vector acceptance',
    );
  const rows: Array<{
    cohort: string;
    index: number;
    ms: number;
    bytes: number;
    estimated_tokens: number;
    failed: boolean;
    degraded: boolean;
    search_id?: string;
    result_sha256?: string;
    error?: string;
  }> = [];
  const protocol = {
    requests: 100,
    per_cohort: 25,
    cohorts: ['cold-serial', 'hot-serial', 'cold-4', 'hot-4'],
    page_size: 5,
    prompts,
    target: { host: target.hostname, port: target.port, database: target.pathname.slice(1) },
    provider: 'dashscope',
    model,
    endpoint:
      process.env.MEM0_EMBEDDING_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    actor: 'copilot',
    freeze:
      'SHARE locks on question, lifecycle, prior and vectors; fail immediately if a writer is active',
    timing:
      'before product input validation through complete JSON serialization; no HTTP/browser/model-turn claim',
    token_estimate: 'ceil(UTF8 bytes/4), not provider usage',
    warmup_requests: 10,
    started_at: new Date().toISOString(),
  };
  writeFileSync(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2));
  console.log(JSON.stringify(protocol));
  try {
    await client.begin(async (locker) => {
      await locker.unsafe(
        'LOCK TABLE question, question_group_lifecycle, question_solution_prior, question_solution_prior_vector IN SHARE MODE NOWAIT',
      );
      const counts = await locker.unsafe(
        "SELECT (SELECT count(*) FROM question) total, (SELECT count(*) FROM question_group_lifecycle WHERE scoring_admission_state='admitted') admitted, (SELECT count(*) FROM question WHERE embedding IS NOT NULL) vectors, (SELECT count(*) FROM question_solution_prior_vector) prior_vectors",
      );
      writeFileSync(join(output, 'corpus.json'), JSON.stringify(counts, null, 2));
      const invoke = async (cohort: string, index: number, measured = true) => {
        if (cohort.startsWith('cold')) clearBankQueryCache(db);
        const ctx = {
          db,
          taskRunId: `bank-bench-${randomUUID()}`,
          callerActor: actor,
        };
        const input = {
          query: prompts[index % prompts.length],
          page_size: 5,
          use: 'practice' as const,
        };
        const start = performance.now();
        let row: (typeof rows)[number];
        try {
          const result = await searchBankTool.execute(ctx, searchBankTool.inputSchema.parse(input));
          const body = JSON.stringify(result);
          row = {
            cohort,
            index,
            ms: performance.now() - start,
            bytes: Buffer.byteLength(body),
            estimated_tokens: Math.ceil(Buffer.byteLength(body) / 4),
            failed: false,
            degraded: !result.coverage.complete,
            search_id: result.search_id,
            result_sha256: createHash('sha256').update(body).digest('hex'),
          };
        } catch (error) {
          row = {
            cohort,
            index,
            ms: performance.now() - start,
            bytes: 0,
            estimated_tokens: 0,
            failed: true,
            degraded: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (measured) {
          rows.push(row);
          appendFileSync(join(output, 'requests.jsonl'), `${JSON.stringify(row)}\n`);
        }
        budgetGuard.assertHealthy();
        return row;
      };
      for (const cohort of protocol.cohorts) {
        if (cohort.startsWith('hot'))
          for (let i = 0; i < prompts.length; i++) await invoke('warmup', i, false);
        const width = cohort.endsWith('-4') ? 4 : 1;
        for (let i = 0; i < 25; i += width)
          await Promise.all(
            Array.from({ length: Math.min(width, 25 - i) }, (_, offset) =>
              invoke(cohort, i + offset),
            ),
          );
      }
    });
    const summaries = protocol.cohorts.map((cohort) => {
      const group = rows.filter((r) => r.cohort === cohort);
      const times = group.map((r) => r.ms).sort((a, b) => a - b);
      const p = (fraction: number) => times[Math.ceil(times.length * fraction) - 1];
      return {
        cohort,
        n: group.length,
        p50_ms: p(0.5),
        p95_ms: p(0.95),
        max_ms: times.at(-1),
        failed: group.filter((r) => r.failed).length,
        degraded: group.filter((r) => r.degraded).length,
        body_bytes_p50: [...group.map((r) => r.bytes)].sort((a, b) => a - b)[12],
        estimated_tokens_p50: [...group.map((r) => r.estimated_tokens)].sort((a, b) => a - b)[12],
      };
    });
    const result = {
      completed: rows.length === 100,
      summaries,
      speed_pass: summaries.every((s) => s.n === 25 && s.p95_ms < 1000 && s.failed === 0),
      note: 'Degradation is never hidden; retrieval quality and model overconfidence require the separate human gold set. No TEST contents are printed.',
    };
    writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (!result.speed_pass) process.exitCode = 1;
  } finally {
    budgetGuard.restore();
    await client.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
