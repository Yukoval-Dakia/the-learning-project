import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db, Tx } from '@/db/client';
import { type CostLedgerEntry, writeCostLedger } from '@/server/ai/log';
import { bailianEmbedCostCny, glmChatCostCny } from '@/server/ai/pricing';

type DbLike = Db | Tx;

export type MemoryCostTracking = {
  db: DbLike;
  taskRunId?: string;
  writeCostLedgerFn?: (db: DbLike, entry: CostLedgerEntry) => Promise<void>;
  llmModel?: string;
  embedModel?: string;
};

type OpenAiCompatUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
};

const memoryCostStorage = new AsyncLocalStorage<MemoryCostTracking>();

let fetchShimInstalled = false;
let delegatedFetch: typeof globalThis.fetch | null = null;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hasPath(url: string, suffix: string): boolean {
  try {
    return new URL(url).pathname.endsWith(suffix);
  } catch {
    return false;
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function recordUsage(ctx: MemoryCostTracking, url: string, body: unknown): Promise<void> {
  const response = jsonObject(body);
  const usage = jsonObject(response?.usage) as OpenAiCompatUsage | null;
  if (!response || !usage) return;

  const promptTokens = exactTokenCount(usage.prompt_tokens);
  if (promptTokens === null) return;

  const responseModel = response.model;
  const model =
    typeof responseModel === 'string' && responseModel.length > 0 ? responseModel : null;
  let entry: CostLedgerEntry | null = null;
  if (hasPath(url, '/embeddings')) {
    entry = {
      task_run_id: ctx.taskRunId,
      task_kind: 'memory_embed',
      provider: 'bailian',
      model: model ?? ctx.embedModel ?? 'text-embedding-v4',
      cost: bailianEmbedCostCny(promptTokens),
      currency: 'CNY',
      tokens_in: promptTokens,
      tokens_out: 0,
    };
  } else if (hasPath(url, '/chat/completions')) {
    const completionTokens = exactTokenCount(usage.completion_tokens);
    if (completionTokens === null) return;
    entry = {
      task_run_id: ctx.taskRunId,
      task_kind: 'memory_extract',
      provider: 'glm',
      model: model ?? ctx.llmModel ?? 'glm-5.2',
      cost: glmChatCostCny(promptTokens, completionTokens),
      currency: 'CNY',
      tokens_in: promptTokens,
      tokens_out: completionTokens,
    };
  }

  if (!entry) return;
  try {
    await (ctx.writeCostLedgerFn ?? writeCostLedger)(ctx.db, entry);
  } catch (error) {
    console.error(`[memory_cost] writeCostLedger failed (${entry.task_kind})`, error);
  }
}

async function inspectResponse(
  ctx: MemoryCostTracking,
  url: string,
  response: Response,
): Promise<void> {
  if (!response.ok) return;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return;
  try {
    await recordUsage(ctx, url, await response.clone().json());
  } catch (error) {
    console.error('[memory_cost] failed to inspect upstream usage', error);
  }
}

export function ensureMemoryUsageFetchInstalled(): void {
  if (fetchShimInstalled) return;
  fetchShimInstalled = true;
  delegatedFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    if (!delegatedFetch) throw new Error('memory usage fetch shim has no delegated fetch');
    const response = await delegatedFetch(input, init);
    const context = memoryCostStorage.getStore();
    if (!context) return response;
    const url = requestUrl(input);
    if (hasPath(url, '/embeddings') || hasPath(url, '/chat/completions')) {
      void inspectResponse(context, url, response);
    }
    return response;
  };
}

export async function runWithMemoryCostTracking<T>(
  context: MemoryCostTracking | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!context) return operation();
  ensureMemoryUsageFetchInstalled();
  return memoryCostStorage.run(context, operation);
}

export function resetMemoryUsageFetchForTests(): void {
  if (delegatedFetch) globalThis.fetch = delegatedFetch;
  fetchShimInstalled = false;
  delegatedFetch = null;
}
