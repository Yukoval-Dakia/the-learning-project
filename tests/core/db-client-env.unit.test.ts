import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../server/env';

describe('database client environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses a DATABASE_URL override applied after loading without requiring an API token', async () => {
    // Given
    vi.stubEnv('DATABASE_URL', 'postgres://loom:loom@remote.example:5432/loom');
    vi.stubEnv('INTERNAL_TOKEN', undefined);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    loadEnv('/tmp/nonexistent-env-root');
    vi.stubEnv('DATABASE_URL', 'postgres://loom:loom@127.0.0.1:1/loom');

    // When
    const { db } = await import('@/db/client');

    // Then
    expect(db.$client.options.host).toEqual(['127.0.0.1']);
    expect(db.$client.options.port).toEqual([1]);
    await db.$client.end({ timeout: 0 });
  });
});
