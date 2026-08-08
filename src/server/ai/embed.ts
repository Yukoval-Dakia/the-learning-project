// YUK-383 Phase 0 — domain text embedder. Reuses the same DashScope (Aliyun
// Bailian) embedding model + dims as the mem0 lane (src/server/memory/client.ts:
// DEFAULT_EMBEDDING_MODEL / DEFAULT_EMBEDDING_DIMS / DEFAULT_EMBEDDING_BASE_URL),
// but writes into Drizzle-managed entity-keyed vector(1024) columns instead of the
// mem0 black-box collection. EMBED_DIMS MUST equal the vector(dims) in schema.ts.

import {
  type DirectProviderOperationContext,
  type DirectProviderOperationOptions,
  createDirectProviderOperationContext,
  executeDirectProviderAttempt,
} from './direct-provider-attempt';

export { isDirectProviderAttemptInvariantError } from './direct-provider-attempt';

export type EmbedProviderAttemptOptions = DirectProviderOperationOptions;

export const EMBED_MODEL = 'text-embedding-v4';
export const EMBED_DIMS = 1024;

// DashScope text-embedding-v4 (compatible-mode /embeddings) caps each request at
// 10 input texts — Alibaba Model Studio's own sample loops with
// DASHSCOPE_MAX_BATCH_SIZE=10, and >10 returns HTTP 400 "batch size is limited
// to 10". embedMany chunks at this size so any caller (e.g. the nightly backfill,
// which passes up to limit=100 rows) is safe regardless of input length.
export const EMBED_MAX_BATCH = 10;

const BASE_URL =
  process.env.MEM0_EMBEDDING_BASE_URL?.trim() ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

interface EmbedItem {
  embedding: number[];
  // openai-compat embeddings responses carry the input position; we reorder by
  // it rather than trusting array position, so a chunk returned out of order (or
  // a compat impl that reorders) never misassigns a vector to the wrong row.
  index?: number;
}

interface EmbedResponse {
  data: EmbedItem[];
  id?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

/** POST one ≤EMBED_MAX_BATCH chunk and return its vectors in input order. */
async function embedChunk(
  chunk: string[],
  apiKey: string,
  providerAttempt: DirectProviderOperationContext,
): Promise<number[][]> {
  const result = await executeDirectProviderAttempt(
    providerAttempt,
    {
      provider: 'dashscope',
      model: EMBED_MODEL,
      lane: 'dashscope.embedding',
      protocol: 'http',
      endpointClass: 'openai-compatible.embeddings',
      operationKind: 'embed_texts',
      unknownCostCurrency: null,
    },
    async (attempt) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: EMBED_MODEL, input: chunk, dimensions: EMBED_DIMS }),
          signal: controller.signal,
        });
      } catch (error) {
        attempt.markTerminal(
          error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'failed',
          error instanceof Error && error.name === 'AbortError'
            ? 'provider_request_aborted'
            : 'provider_network_error',
        );
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const headerRequestId = res.headers?.get('x-request-id');
      if (headerRequestId) await attempt.recordExternalRequestId(headerRequestId);
      if (!res.ok) {
        attempt.markTerminal('failed', `provider_http_${res.status}`);
        throw new Error(`embedMany: DashScope ${res.status} ${await res.text()}`);
      }

      let json: EmbedResponse;
      try {
        json = (await res.json()) as EmbedResponse;
        if (!headerRequestId && json.id) await attempt.recordExternalRequestId(json.id);
        const input = json.usage?.prompt_tokens;
        const total = json.usage?.total_tokens;
        if (typeof input === 'number' || typeof total === 'number') {
          attempt.reportUsage({
            input: typeof input === 'number' ? input : null,
            output: null,
            total: typeof total === 'number' ? total : null,
          });
        }
        if (json.data.length !== chunk.length) {
          throw new Error(
            `embedMany: DashScope returned ${json.data.length} vectors for ${chunk.length} inputs`,
          );
        }
        const out = new Array<number[]>(chunk.length);
        for (let i = 0; i < json.data.length; i++) {
          const item = json.data[i];
          const pos = typeof item.index === 'number' ? item.index : i;
          if (pos < 0 || pos >= chunk.length || out[pos] !== undefined) {
            throw new Error(`embedMany: DashScope returned invalid/duplicate index ${pos}`);
          }
          if (
            !Array.isArray(item.embedding) ||
            item.embedding.length !== EMBED_DIMS ||
            item.embedding.some((n) => typeof n !== 'number' || !Number.isFinite(n))
          ) {
            throw new Error(`embedMany: DashScope returned invalid embedding at index ${pos}`);
          }
          out[pos] = item.embedding;
        }
        return out;
      } catch (error) {
        attempt.markTerminal('failed', 'provider_response_malformed');
        throw error;
      }
    },
  );
  return result.value;
}

/** Embed a batch of texts into 1024-dim vectors via the openai-compat /embeddings
 *  endpoint, reusing DASHSCOPE_API_KEY. Chunks at EMBED_MAX_BATCH (=10) to respect
 *  the DashScope per-request cap and stitches chunk results back in input order.
 *  Throws on a non-ok response so callers (the nightly backfill job) leave rows
 *  NULL and retry next run (§9 fallback). */
export async function embedMany(
  texts: string[],
  providerAttempt?: EmbedProviderAttemptOptions,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!providerAttempt) throw new TypeError('embedMany requires provider attempt context');
  const providerOperation = createDirectProviderOperationContext(providerAttempt);
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error('embedMany: DASHSCOPE_API_KEY is unset');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
    const chunk = texts.slice(i, i + EMBED_MAX_BATCH);
    const vecs = await embedChunk(chunk, apiKey, providerOperation);
    for (const v of vecs) out.push(v);
  }
  return out;
}

export async function embedText(
  text: string,
  providerAttempt?: EmbedProviderAttemptOptions,
): Promise<number[]> {
  const [v] = await embedMany([text], providerAttempt);
  return v;
}
