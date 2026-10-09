import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerEnv, getServerEnv } from '@/server/env';
import { loadApiEnv, loadEnv } from '../../server/env';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable',
  INTERNAL_TOKEN: 'test-internal-token',
};

describe('createServerEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses required and optional values when the runtime environment is valid', () => {
    // Given
    const runtimeEnv = {
      ...REQUIRED_ENV,
      DOCX_CONVERT_ENGINE: 'docker',
      EXTRACT_OCR_ENGINE: 'tencent',
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: 'true',
    };

    // When
    const env = createServerEnv(runtimeEnv, false);

    // Then
    expect(env).toMatchObject(runtimeEnv);
  });

  it('preserves OS paths and an explicit cutover image without normalizing them', () => {
    const runtimeEnv = {
      ...REQUIRED_ENV,
      HOME: '/Users/Restore Operator',
      PATH: '/opt/Postgres Tools/bin:/usr/local/bin:/usr/bin:/bin',
      TMPDIR: '/private/var/folders/restore workspace/',
      LOOM_PG_IMAGE: `registry.example/pgvector@sha256:${'a'.repeat(64)}`,
    };

    expect(createServerEnv(runtimeEnv, false)).toMatchObject(runtimeEnv);
  });

  it('allows OS paths and the cutover image to be absent without supplying defaults', () => {
    const env = createServerEnv(REQUIRED_ENV, false);

    expect(env.HOME).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.LOOM_PG_IMAGE).toBeUndefined();
  });

  it('treats empty OS paths and cutover image values as unset in the shared schema', () => {
    const env = createServerEnv(
      { ...REQUIRED_ENV, HOME: '', PATH: '', TMPDIR: '', LOOM_PG_IMAGE: '' },
      false,
    );

    expect(env.HOME).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.LOOM_PG_IMAGE).toBeUndefined();
  });

  it('rejects startup when a required value is missing', () => {
    // Given
    const runtimeEnv = { INTERNAL_TOKEN: REQUIRED_ENV.INTERNAL_TOKEN };

    // When / Then
    expect(() => createServerEnv(runtimeEnv, false)).toThrow();
  });

  it('rejects unsupported engine selectors', () => {
    // Given
    const runtimeEnv = { ...REQUIRED_ENV, EXTRACT_OCR_ENGINE: 'legacy' };

    // When / Then
    expect(() => createServerEnv(runtimeEnv, false)).toThrow();
  });

  it('allows Vitest bootstrap to defer validation until test env rewrites complete', () => {
    // Given
    const runtimeEnv = { VITEST: 'true' };

    // When / Then
    expect(() => createServerEnv(runtimeEnv)).not.toThrow();
  });

  it('reads a DATABASE_URL override applied after initial env loading', () => {
    // Given
    vi.stubEnv('DATABASE_URL', 'postgres://loom:loom@remote.example:5432/loom');
    vi.stubEnv('INTERNAL_TOKEN', undefined);
    vi.stubEnv('VITEST', undefined);
    loadEnv('/tmp/nonexistent-env-root');

    // When
    vi.stubEnv('DATABASE_URL', 'postgres://loom:loom@127.0.0.1:5433/loom');

    // Then
    expect(getServerEnv().DATABASE_URL).toBe('postgres://loom:loom@127.0.0.1:5433/loom');
  });

  it('accepts legacy DOCX selector values as the disabled default', () => {
    // Given
    const runtimeEnv = { DATABASE_URL: REQUIRED_ENV.DATABASE_URL, DOCX_CONVERT_ENGINE: 'legacy' };

    // When
    const env = createServerEnv(runtimeEnv, false);

    // Then
    expect(env.DOCX_CONVERT_ENGINE).toBeUndefined();
  });

  it('fails API startup when INTERNAL_TOKEN is missing', () => {
    // Given
    vi.stubEnv('DATABASE_URL', REQUIRED_ENV.DATABASE_URL);
    vi.stubEnv('INTERNAL_TOKEN', undefined);
    vi.stubEnv('VITEST', undefined);

    // When / Then
    expect(() => loadApiEnv('/tmp/nonexistent-env-root')).toThrow('INTERNAL_TOKEN');
  });
});
