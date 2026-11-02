import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnJyeooFetch } from './jyeoo-spawn';

// These exercise the REAL bounded-subprocess machinery against tiny fake producers
// (/bin/sh + node one-liners). No DB — valid unit partition.
const SH = '/bin/sh';
const generous = { timeoutMs: 5000, maxStdoutBytes: 1_000_000, maxStderrBytes: 100_000 };

describe('spawnJyeooFetch', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('excludes unrelated server secrets from the producer and its helpers', async () => {
    const secrets = {
      INTERNAL_TOKEN: 'fake-internal-token',
      DATABASE_URL: 'postgres://fake:fake@invalid.example/fake',
      R2_ACCESS_KEY_ID: 'fake-r2-key',
      R2_SECRET_ACCESS_KEY: 'fake-r2-secret',
      AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
      OPENAI_API_KEY: 'fake-provider-key',
      UNRELATED_FUTURE_SECRET: 'fake-future-secret',
      JYEOO_UNRECOGNIZED_SECRET: 'fake-prefixed-secret',
      NODE_OPTIONS: '--trace-warnings',
      LD_PRELOAD: '/nonexistent/fake-library.so',
    };
    for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
    // Only report presence booleans. Never dump the actual host environment or values.
    const probe = `const keys = ${JSON.stringify(Object.keys(secrets))};
      process.stdout.write(JSON.stringify(keys.map(key => Object.hasOwn(process.env, key))));`;
    for (const env of [undefined, secrets]) {
      const r = await spawnJyeooFetch({
        binaryPath: SH,
        args: ['-c', '"$1" -e "$2"', 'probe', process.execPath, probe],
        env,
        ...generous,
      });
      expect(r.exitCode).toBe(0);
      expect.soft(JSON.parse(r.lines.join(''))).toEqual(Object.keys(secrets).map(() => false));
    }
  });
});
