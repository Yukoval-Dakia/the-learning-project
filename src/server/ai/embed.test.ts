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
});
