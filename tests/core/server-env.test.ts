import { describe, expect, it } from 'vitest';

import { createServerEnv } from '@/server/env';

const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://loom:loom@127.0.0.1:5433/loom?sslmode=disable',
  INTERNAL_TOKEN: 'test-internal-token',
};

describe('createServerEnv', () => {
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
});
