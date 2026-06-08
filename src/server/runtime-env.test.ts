// YUK-239 (STB-5) — unit coverage for the shared background-job enqueue guard.
//
// Pure env read, no DB / pg-boss — lives in the unit partition (registered in
// vitest.shared.ts fastTestInclude). We toggle NODE_ENV / VITEST with
// vi.stubEnv so the assertions don't depend on the ambient runner env.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldEnqueueBackgroundJobs } from './runtime-env';

describe('shouldEnqueueBackgroundJobs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips enqueue when NODE_ENV is test (vitest sets this by default)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', '');
    expect(shouldEnqueueBackgroundJobs()).toBe(false);
  });

  it('skips enqueue when VITEST is set even if NODE_ENV is not test', () => {
    // Defends the historical seam: the six routes previously keyed only on
    // VITEST, so honouring it keeps every existing "no enqueue under vitest"
    // test green regardless of NODE_ENV.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITEST', 'true');
    expect(shouldEnqueueBackgroundJobs()).toBe(false);
  });

  it('skips enqueue when both NODE_ENV=test and VITEST are set (real vitest runtime)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');
    expect(shouldEnqueueBackgroundJobs()).toBe(false);
  });

  it('enqueues in production (NODE_ENV=production, no VITEST)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');
    expect(shouldEnqueueBackgroundJobs()).toBe(true);
  });

  it('enqueues in plain development (NODE_ENV=development, no VITEST)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITEST', '');
    expect(shouldEnqueueBackgroundJobs()).toBe(true);
  });

  it('enqueues when NODE_ENV is unset and VITEST is unset', () => {
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('VITEST', '');
    expect(shouldEnqueueBackgroundJobs()).toBe(true);
  });
});
