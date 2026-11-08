/** Synthetic query latency only; this is not the search tool's end-to-end gate. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { EMBED_DIMS, EMBED_MODEL, embedText } from '@/server/ai/embed';
import { DASHSCOPE_EMBED_MODEL_ID } from '@/server/ai/providers';
import {
  assertSearchBenchmarkPaidGate,
  guardSearchBenchmarkEmbedding,
} from './search-bank-paid-gate';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port !== '5434' ||
    !url.pathname.startsWith('/loom_dev_')
  )
    throw Error('Only an isolated local dev database is allowed');
  if (EMBED_MODEL !== DASHSCOPE_EMBED_MODEL_ID || !process.env.DASHSCOPE_API_KEY)
    throw Error('Confirmed v4 credentials required');
  const output = process.env.SEARCH_BENCH_OUTPUT;
  if (!output) throw Error('External SEARCH_BENCH_OUTPUT required');
  mkdirSync(output, { recursive: true });
  console.log(
    JSON.stringify({
      provider: 'dashscope',
      model: EMBED_MODEL,
      dimensions: EMBED_DIMS,
      endpoint: process.env.MEM0_EMBEDDING_BASE_URL,
      n: 24,
      estimate_usd_ceiling: 0.002,
    }),
  );
  if (existsSync(join(output, 'latency-rows.json')))
    throw Error('Fixed sample already started; no reruns');
  assertSearchBenchmarkPaidGate(output);
  const guard = guardSearchBenchmarkEmbedding(output, 0.002);
  const client = postgres(url.toString(), { max: 2 });
  const db = drizzle(client, { schema }) as Db;
  const rows: Array<{ index: number; ms: number; dimensions: number; error?: string }> = [];
  try {
    for (let i = 0; i < 24; i++) {
      const start = performance.now();
      try {
        const vector = await embedText(`合成检索延迟样本${i}：一次函数、方程与概率。`, {
          db,
          caller: 'api',
          deadlineAt: new Date(Date.now() + 20_000),
        });
        rows.push({ index: i, ms: performance.now() - start, dimensions: vector.length });
      } catch (error) {
        rows.push({
          index: i,
          ms: performance.now() - start,
          dimensions: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      writeFileSync(join(output, 'latency-rows.json'), JSON.stringify(rows, null, 2));
      guard.assertHealthy();
    }
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const summary = {
      n: rows.length,
      failed: rows.filter((r) => r.error).length,
      p50_ms: times[11],
      p95_ms: times[22],
      max_ms: times.at(-1),
      timing: 'product embedText including provider-attempt DB ledger; synthetic strings only',
    };
    writeFileSync(join(output, 'latency-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    guard.restore();
    await client.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
