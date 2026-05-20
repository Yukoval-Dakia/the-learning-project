import { describe, expect, it } from 'vitest';
import { buildLocalDatabaseUrl, buildLocalDevEnv } from './local-db-env';

describe('local dev DB env', () => {
  it('builds the host-side compose Postgres URL from docker defaults', () => {
    expect(
      buildLocalDatabaseUrl({
        POSTGRES_USER: 'loom',
        POSTGRES_PASSWORD: 'loom',
        POSTGRES_DB: 'loom',
      }),
    ).toBe('postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable');
  });

  it('supports custom host port without changing compose-internal DATABASE_URL', () => {
    expect(
      buildLocalDatabaseUrl({
        POSTGRES_USER: 'dev user',
        POSTGRES_PASSWORD: 'dev/pass',
        POSTGRES_DB: 'learning db',
        LOCAL_POSTGRES_PORT: '15433',
      }),
    ).toBe('postgres://dev%20user:dev%2Fpass@127.0.0.1:15433/learning%20db?sslmode=disable');
  });

  it('builds Next dev env without reading stale .env.local DATABASE_URL', () => {
    const env = buildLocalDevEnv({
      POSTGRES_USER: 'loom',
      POSTGRES_PASSWORD: 'loom',
      POSTGRES_DB: 'loom',
      LOCAL_NEXT_PORT: '3002',
    });

    expect(env.DATABASE_URL).toBe('postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable');
    expect(env.NEXT_PUBLIC_BASE_URL).toBe('http://127.0.0.1:3002');
  });
});
