// YUK-383 Phase 0 — domain text embedder. Reuses the same DashScope (Aliyun
// Bailian) embedding model + dims as the mem0 lane (src/server/memory/client.ts:
// DEFAULT_EMBEDDING_MODEL / DEFAULT_EMBEDDING_DIMS / DEFAULT_EMBEDDING_BASE_URL),
// but writes into Drizzle-managed entity-keyed vector(1024) columns instead of the
// mem0 black-box collection. EMBED_DIMS MUST equal the vector(dims) in schema.ts.

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

/** POST one ≤EMBED_MAX_BATCH chunk and return its vectors in input order. */
async function embedChunk(chunk: string[], apiKey: string): Promise<number[][]> {
  // Timeout so a hung upstream can't pin a pg-boss worker thread indefinitely;
  // the abort surfaces as a throw → job fails, rows stay NULL, retried next run.
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
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`embedMany: DashScope ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: EmbedItem[] };
  if (json.data.length !== chunk.length) {
    throw new Error(
      `embedMany: DashScope returned ${json.data.length} vectors for ${chunk.length} inputs`,
    );
  }
  const out = new Array<number[]>(chunk.length);
  for (let i = 0; i < json.data.length; i++) {
    const item = json.data[i];
    // Fall back to array position only when index is absent.
    const pos = typeof item.index === 'number' ? item.index : i;
    if (pos < 0 || pos >= chunk.length || out[pos] !== undefined) {
      throw new Error(`embedMany: DashScope returned invalid/duplicate index ${pos}`);
    }
    // Validate the vector itself (dims + finite numbers) so a malformed response
    // fails fast here instead of surfacing as a DB write/dimension error later.
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
}

/** Embed a batch of texts into 1024-dim vectors via the openai-compat /embeddings
 *  endpoint, reusing DASHSCOPE_API_KEY. Chunks at EMBED_MAX_BATCH (=10) to respect
 *  the DashScope per-request cap and stitches chunk results back in input order.
 *  Throws on a non-ok response so callers (the nightly backfill job) leave rows
 *  NULL and retry next run (§9 fallback). */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error('embedMany: DASHSCOPE_API_KEY is unset');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
    const chunk = texts.slice(i, i + EMBED_MAX_BATCH);
    const vecs = await embedChunk(chunk, apiKey);
    for (const v of vecs) out.push(v);
  }
  return out;
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedMany([text]);
  return v;
}
