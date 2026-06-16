// YUK-383 Phase 0 — domain text embedder. Reuses the same DashScope (Aliyun
// Bailian) embedding model + dims as the mem0 lane (src/server/memory/client.ts:
// DEFAULT_EMBEDDING_MODEL / DEFAULT_EMBEDDING_DIMS / DEFAULT_EMBEDDING_BASE_URL),
// but writes into Drizzle-managed entity-keyed vector(1024) columns instead of the
// mem0 black-box collection. EMBED_DIMS MUST equal the vector(dims) in schema.ts.

export const EMBED_MODEL = 'text-embedding-v4';
export const EMBED_DIMS = 1024;

const BASE_URL =
  process.env.MEM0_EMBEDDING_BASE_URL?.trim() ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** Embed a batch of texts into 1024-dim vectors via the openai-compat /embeddings
 *  endpoint, reusing DASHSCOPE_API_KEY. Throws on a non-ok response so callers
 *  (the nightly backfill job) leave rows NULL and retry next run (§9 fallback). */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new Error('embedMany: DASHSCOPE_API_KEY is unset');
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) {
    throw new Error(`embedMany: DashScope ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedMany([text]);
  return v;
}
