import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.DASHSCOPE_API_KEY = 'test-key';
});

describe('embedMany', () => {
  it('posts to compat /embeddings and returns 1024-dim vectors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    const out = await embedMany(['hello']);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1024);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/embeddings$/);
    expect(JSON.parse(init.body).model).toBe('text-embedding-v4');
    expect(JSON.parse(init.body).dimensions).toBe(1024);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' }),
    );
    const { embedMany } = await import('./embed');
    await expect(embedMany(['x'])).rejects.toThrow(/503/);
  });

  it('chunks inputs at the DashScope batch cap (10) and stitches in order', async () => {
    // 25 inputs -> 3 requests (10 + 10 + 5). Each request must carry <= 10 inputs;
    // each chunk responds with index-tagged items returned out of order, and the
    // final stitched output must follow the original input order.
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const inputs = JSON.parse(init.body).input as string[];
      expect(inputs.length).toBeLessThanOrEqual(10);
      // Encode the input's own value into the embedding so we can verify ordering.
      const data = inputs.map((text, i) => ({
        index: i,
        embedding: Array(1024).fill(Number(text)),
      }));
      // Return out of order to exercise index-based reassembly.
      data.reverse();
      return { ok: true, json: async () => ({ data }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    const texts = Array.from({ length: 25 }, (_, i) => String(i));
    const out = await embedMany(texts);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(25);
    // out[i] should encode input i (i.e. vector filled with Number(texts[i]) = i).
    out.forEach((v, i) => expect(v[0]).toBe(i));
  });

  it('throws when a chunk returns the wrong number of vectors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: Array(1024).fill(0.01) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    await expect(embedMany(['a', 'b'])).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });
});
