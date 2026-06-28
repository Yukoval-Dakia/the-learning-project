// YUK-360 — fetch interception shim for mem0 A/B cost observability.
//
// mem0ai/oss buries GLM extract (chat/completions) and 百炼 embedding (/embeddings)
// inside Memory.add()/search() without surfacing usage. We patch global fetch once
// and scope ledger writes with AsyncLocalStorage so only memory client calls
// (wrapped by runWithMemoryCostTracking) record rows.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db, Tx } from '@/db/client';
import { type CostLedgerEntry, writeCostLedger } from '@/server/ai/log';
import { bailianEmbedCostCny, glmChatCostCny } from '@/server/ai/pricing';

type DbLike = Db | Tx;

export type MemoryCostTracking = {
  db: DbLike;
  taskRunId?: string;
  /** Injectable seam for tests — defaults to writeCostLedger. */
  writeCostLedgerFn?: (db: DbLike, entry: CostLedgerEntry) => Promise<void>;
  /** Fallback model ids when the upstream JSON omits `model`. */
  llmModel?: string;
  embedModel?: string;
};

type OpenAiCompatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

const memoryCostAls = new AsyncLocalStorage<MemoryCostTracking>();

let fetchShimInstalled = false;
let nativeFetch: typeof globalThis.fetch | null = null;

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isEmbeddingsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/embeddings');
  } catch {
    return url.includes('/embeddings');
  }
}

function isChatCompletionsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/chat/completions');
  } catch {
    return url.includes('/chat/completions');
  }
}

function readUsage(json: unknown): OpenAiCompatUsage | null {
  if (!json || typeof json !== 'object') return null;
  const usage = (json as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  return usage as OpenAiCompatUsage;
}

function readModel(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const model = (json as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

async function recordUsage(ctx: MemoryCostTracking, url: string, body: unknown): Promise<void> {
  const usage = readUsage(body);
  if (!usage) return;

  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const write = ctx.writeCostLedgerFn ?? writeCostLedger;

  let entry: CostLedgerEntry | null = null;
  if (isEmbeddingsUrl(url)) {
    entry = {
      task_run_id: ctx.taskRunId,
      task_kind: 'memory_embed',
      provider: 'bailian',
      model: readModel(body) ?? ctx.embedModel ?? 'text-embedding-v4',
      cost: bailianEmbedCostCny(promptTokens),
      currency: 'CNY',
      tokens_in: promptTokens,
      tokens_out: 0,
    };
  } else if (isChatCompletionsUrl(url)) {
    entry = {
      task_run_id: ctx.taskRunId,
      task_kind: 'memory_extract',
      provider: 'glm',
      model: readModel(body) ?? ctx.llmModel ?? 'glm-5.2',
      cost: glmChatCostCny(promptTokens, completionTokens),
      currency: 'CNY',
      tokens_in: promptTokens,
      tokens_out: completionTokens,
    };
  }

  if (!entry) return;
  try {
    await write(ctx.db, entry);
  } catch (err) {
    console.error(`[memory_cost] writeCostLedger failed (${entry.task_kind})`, err);
  }
}

async function inspectResponse(
  ctx: MemoryCostTracking,
  url: string,
  response: Response,
): Promise<void> {
  if (!response.ok) return;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('json')) return;
  try {
    const body = await response.clone().json();
    await recordUsage(ctx, url, body);
  } catch (err) {
    console.error('[memory_cost] failed to parse upstream usage', err);
  }
}

/** Install a one-time global fetch wrapper. Safe to call repeatedly. */
export function ensureMemoryUsageFetchInstalled(): void {
  if (fetchShimInstalled) return;
  fetchShimInstalled = true;
  nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    if (!nativeFetch) {
      throw new Error('memory usage fetch shim installed without native fetch');
    }
    const response = await nativeFetch(input, init);
    const ctx = memoryCostAls.getStore();
    if (!ctx) return response;
    const url = resolveRequestUrl(input);
    if (!isEmbeddingsUrl(url) && !isChatCompletionsUrl(url)) return response;
    void inspectResponse(ctx, url, response);
    return response;
  };
}

/** Run a memory client operation with cost-ledger context active for fetch shim. */
export async function runWithMemoryCostTracking<T>(
  ctx: MemoryCostTracking | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ctx) return fn();
  ensureMemoryUsageFetchInstalled();
  return memoryCostAls.run(ctx, fn);
}

/** Test-only reset — restores native fetch between unit tests. */
export function resetMemoryUsageFetchForTests(): void {
  if (nativeFetch) {
    globalThis.fetch = nativeFetch;
  }
  fetchShimInstalled = false;
  nativeFetch = null;
}
