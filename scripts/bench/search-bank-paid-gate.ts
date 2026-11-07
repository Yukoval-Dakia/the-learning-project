import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Mandatory before any paid benchmark work; it does not shorten product deadlines. */
export function assertSearchBenchmarkPaidGate(output: string) {
  mkdirSync(output, { recursive: true });
  const record: Record<string, unknown> = {
    at: new Date().toISOString(),
    platform: process.platform,
    provider: 'dashscope',
    model: process.env.MEM0_EMBEDDING_MODEL || 'text-embedding-v4',
    endpoint: process.env.MEM0_EMBEDDING_BASE_URL,
    dimensions: 1024,
  };
  if (process.platform === 'darwin') {
    const raw = execFileSync('sysctl', ['vm.swapusage'], { encoding: 'utf8' }).trim();
    const parsed = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(raw);
    if (!parsed) throw Error('Cannot read the required swap gate');
    record.swap = raw;
    record.used_fraction = Number(parsed[2]) / Number(parsed[1]);
    if (Number(parsed[1]) > 0 && Number(record.used_fraction) > 0.9) {
      record.allowed = false;
      appendFileSync(join(output, 'paid-gates.jsonl'), `${JSON.stringify(record)}\n`);
      throw Error('Owner swap gate: used >90%; paid work did not start');
    }
  }
  record.allowed = true;
  appendFileSync(join(output, 'paid-gates.jsonl'), `${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record));
}

/** Embedding-only benchmark guard: prices each token at a conservative $1/M ceiling. */
export function guardSearchBenchmarkEmbedding(output: string, budgetUsd: number) {
  const realFetch = globalThis.fetch;
  const ledgerPath = process.env.SEARCH_BENCH_SPEND_FILE;
  if (!ledgerPath)
    throw Error('Shared SEARCH_BENCH_SPEND_FILE required for the cumulative $1.50 cap');
  const ledger = existsSync(ledgerPath)
    ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { spent_usd_ceiling: number })
    : { spent_usd_ceiling: Number(process.env.SEARCH_BENCH_PRIOR_SPEND_USD) };
  if (!Number.isFinite(ledger.spent_usd_ceiling) || ledger.spent_usd_ceiling < 0)
    throw Error('Known cumulative prior spend required; never reset it to zero');
  const prior = ledger.spent_usd_ceiling;
  let spent = 0;
  let reserved = 0;
  let blocked = false;
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url instanceof Request ? url.url : url);
    if (/\/chat\/completions|\/messages(?:\?|$)/.test(endpoint))
      throw Error('This benchmark must not run a reasoning model');
    if (!endpoint.endsWith('/embeddings')) return realFetch(url, init);
    const body = JSON.parse(String(init?.body));
    if (body.model !== 'text-embedding-v4' || body.dimensions !== 1024)
      throw Error('Unexpected embedding model/dimensions');
    const bytes = Buffer.byteLength(JSON.stringify(body.input));
    const hold = bytes / 1e6;
    if (spent + reserved + hold > budgetUsd || prior + spent + reserved + hold > 1.5) {
      blocked = true;
      throw Error('Embedding benchmark budget ceiling reached before send');
    }
    reserved += hold;
    const started = Date.now();
    let tokens: number | null = null;
    let status: number | null = null;
    try {
      const response = await realFetch(url, init);
      status = response.status;
      const json = (await response.clone().json()) as {
        usage?: { total_tokens?: number; prompt_tokens?: number };
      };
      tokens = json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? null;
      if (status === 401 || status === 403) blocked = true;
      return response;
    } finally {
      reserved -= hold;
      spent += (tokens ?? bytes) / 1e6;
      writeFileSync(
        ledgerPath,
        JSON.stringify(
          {
            spent_usd_ceiling: prior + spent,
            cap_usd: 1.5,
            includes_prior: true,
            price_basis: 'conservative reserve, not invoice',
          },
          null,
          2,
        ),
      );
      appendFileSync(
        join(output, 'embedding-cost.jsonl'),
        `${JSON.stringify({
          at: new Date().toISOString(),
          status,
          ms: Date.now() - started,
          tokens,
          byte_upper_bound: bytes,
          budget_charge_usd_ceiling: (tokens ?? bytes) / 1e6,
          cumulative_ceiling_usd: spent,
          price_basis: '1 USD/M upper bound; reported tokens or byte bound, not invoice',
        })}\n`,
      );
    }
  };
  return {
    assertHealthy() {
      if (blocked)
        throw Error('Authentication/budget gate stopped paid work; fixed benchmark is incomplete');
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}
