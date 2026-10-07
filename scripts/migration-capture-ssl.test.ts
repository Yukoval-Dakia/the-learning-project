import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMigrationCheckpoint } from '@/server/migration/capture';
import { advisoryFence, applyTargetSsl } from './migration-apply';
import { parseCaptureArgs, runMigrationCapture } from './migration-capture';

vi.mock('postgres', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock('@/server/migration/capture', () => ({ captureMigrationCheckpoint: vi.fn() }));

const STOP_BEFORE_QUERY = new Error('capture checkpoint intercepted before any database query');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.mocked(captureMigrationCheckpoint).mockRejectedValue(STOP_BEFORE_QUERY);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function connectionOptions(target: string, fromEnvironment = false) {
  if (fromEnvironment) vi.stubEnv('DATABASE_URL', target);
  const args = parseCaptureArgs([
    '--out',
    join(tmpdir(), 'capture-tls-no-artifact-written'),
    ...(fromEnvironment ? [] : ['--target', target]),
  ]);
  await expect(runMigrationCapture(args)).rejects.toBe(STOP_BEFORE_QUERY);
  expect(captureMigrationCheckpoint).toHaveBeenCalledOnce();
  const client = vi.mocked(postgres).mock.results.at(-1)?.value;
  expect(client).toBeDefined();
  return client.options;
}

describe('migration capture TLS at the real postgres-js connection boundary', () => {
  it.each([
    'postgres://fixture:localhost@remote.example.invalid/db',
    'postgres://fixture:127.0.0.1@remote.example.invalid/db',
    'postgres://fixture:fixture@remote.example.invalid/localhost-copy',
    'postgres://fixture:fixture@remote.example.invalid/db?application_name=localhost-drill',
    'postgres://fixture:localhost@remote.example.invalid/db?sslmode=require',
    'postgres://fixture:fixture@localhost.example.invalid/db',
    'postgres://fixture:fixture@remote.example.invalid/db?sslmode=disable-extra',
    'postgres://fixture:fixture@remote.example.invalid,db.localhost/db',
    'postgres://fixture:fixture@remote.example.invalid%2Cdb.localhost/db',
    'postgres://fixture:fixture@remote.example.invalid,extra@db.localhost/db',
    'postgres://fixture:fixture@db.localhost#fragment,remote.example.invalid/db',
    'postgres://fixture:fixture@remote.example.invalid/db?sslmode=require&sslmode=disable',
  ])('requires TLS for %s', async (target) => {
    const options = await connectionOptions(target);
    expect(options.ssl).toBe('require');
  });

  it.each([
    'postgres://fixture:fixture@localhost:5432/db',
    'postgres://fixture:fixture@127.0.0.1:5432/db',
    'postgres://fixture:fixture@db.localhost/db',
    'postgres://fixture:fixture@remote.example.invalid/db?sslmode=disable',
    'postgres://fixture:fixture@remote.example.invalid/db?sslmode=%64isable',
    'postgres://fixture:escaped%40password@localhost/db',
    'postgres://fixture:fixture@remote.example.invalid/db?sslmode=disable&sslmode=require',
  ])('preserves explicit or loopback plaintext for %s', async (target) => {
    expect((await connectionOptions(target)).ssl).toBe(false);
  });

  it('applies the same policy to DATABASE_URL fallback without opening a connection', async () => {
    const options = await connectionOptions(
      'postgres://fixture:fixture@remote.example.invalid/localhost-copy',
      true,
    );
    expect(options.host).toEqual(['remote.example.invalid']);
    expect(options.ssl).toBe('require');
  });
});

describe('shared migration apply connection policy', () => {
  it.each([
    'postgres://fixture:fixture@remote.example.invalid,db.localhost/db',
    'postgres://fixture:fixture@remote.example.invalid%2Cdb.localhost/db',
    'postgres://fixture:fixture@remote.example.invalid,extra@db.localhost/db',
  ])('also protects the apply fence driver for %s', async (target) => {
    const fence = advisoryFence(target);
    try {
      const client = vi.mocked(postgres).mock.results.at(-1)?.value;
      expect(client.options.host[0]).toBe('remote.example.invalid');
      expect(client.options.ssl).toBe('require');
    } finally {
      await fence.close();
    }
  });

  it('keeps malformed targets fail-closed and existing loopback aliases compatible', () => {
    expect(applyTargetSsl('not a url')).toBe('require');
    expect(applyTargetSsl('postgres://fixture:fixture@LOCALHOST/db')).toBe(false);
    expect(applyTargetSsl('postgres://fixture:fixture@127.8.9.10/db')).toBe(false);
    expect(applyTargetSsl('postgres://fixture:fixture@[::1]/db')).toBe(false);
    expect(applyTargetSsl('postgres://fixture:fixture@localhost./db')).toBe('require');
  });
});
