import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { testDb } from '../../../tests/helpers/db';
import { createMemoryClient } from './client';

it('initializes the actual SDK once for concurrent exact lookups without provider calls', async () => {
  vi.stubEnv('MEM0_TELEMETRY', 'false');
  const history = mkdtempSync(path.join(tmpdir(), 'mem0-lazy-client-'));
  let providerCalls = 0;
  const server = createServer((_request, response) => {
    providerCalls++;
    response.writeHead(500).end('provider calls forbidden in read-only initialization');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const client = createMemoryClient({
      env: {
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        ZHIPU_API_KEY: 'test-only',
        DASHSCOPE_API_KEY: 'test-only',
        MEM0_LLM_BASE_URL: endpoint,
        MEM0_EMBEDDING_BASE_URL: endpoint,
        MEM0_EMBEDDING_DIMS: '4',
        MEM0_PGVECTOR_COLLECTION: 'yuk1107_lazy_sdk_probe',
        MEM0_HISTORY_DB_PATH: path.join(history, 'history.db'),
      },
    });
    expect(
      await Promise.all([
        client.findByEventId('missing-event-a'),
        client.findByEventId('missing-event-b'),
      ]),
    ).toEqual([{ results: [] }, { results: [] }]);
    expect(await client.history('missing-memory')).toEqual([]);
    expect(providerCalls).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testDb().execute(sql`DROP TABLE IF EXISTS yuk1107_lazy_sdk_probe CASCADE`);
    rmSync(history, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
