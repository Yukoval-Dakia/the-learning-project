import { afterEach, describe, expect, it, vi } from 'vitest';
import { sliceToCharBoundary, spawnJyeooFetch } from './jyeoo-spawn';

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

  it('captures NDJSON stdout as lines on a clean exit', async () => {
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      args: ['-c', 'printf "a\\nb\\nc\\n"'],
      ...generous,
    });
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.timedOut).toBe(false);
    // trailing "\n" yields a final empty element — the adapter treats blank lines as skips.
    expect(r.lines).toEqual(['a', 'b', 'c', '']);
    expect(r.stdoutTruncated).toBe(false);
  });

  it('returns a non-zero exit code without rejecting', async () => {
    const r = await spawnJyeooFetch({ binaryPath: SH, args: ['-c', 'exit 3'], ...generous });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('captures stderr and the exit code together', async () => {
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      args: ['-c', 'echo boom >&2; exit 4'],
      ...generous,
    });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain('boom');
  });

  it('kills a wedged process at the wall-clock timeout', async () => {
    const startedAt = performance.now();
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      // Two descendant levels verify that the timeout kills the process tree, not only
      // the direct shell while its children keep the captured stdio pipes open.
      args: ['-c', 'sh -c "sleep 5"'],
      timeoutMs: 100,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 100_000,
    });
    const elapsedMs = performance.now() - startedAt;
    expect(r.timedOut).toBe(true);
    // SIGKILL leaves a null exit code + the signal name.
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe('SIGKILL');
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('kills descendants that retain stdio after their wrapper exits', async () => {
    const startedAt = performance.now();
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      // The wrapper exits 0 immediately; the background child inherits stdout/stderr.
      // Waiting for ChildProcess "close" would otherwise take the full five seconds.
      args: ['-c', 'sleep 5 &'],
      timeoutMs: 100,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 100_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it('flags stdout truncation when the byte cap is exceeded', async () => {
    const r = await spawnJyeooFetch({
      binaryPath: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(1000))'],
      timeoutMs: 5000,
      maxStdoutBytes: 100,
      maxStderrBytes: 100_000,
    });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.lines.join('').length).toBeLessThanOrEqual(100);
  });

  it('rejects on an OS spawn failure (binary not found)', async () => {
    await expect(
      spawnJyeooFetch({
        binaryPath: '/nonexistent/jyeoo-rs-binary-xyz',
        args: ['search'],
        ...generous,
      }),
    ).rejects.toThrow();
  });

  it('does not flag timedOut for a process that exits cleanly before the deadline', async () => {
    // Exercises the timeout race guard: a process that finishes (exitCode set) before the
    // timer fires must resolve timedOut=false — never a false timeout → false retry.
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      args: ['-c', 'sleep 0.1; printf done'],
      timeoutMs: 2000,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 100_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('')).toContain('done');
  });

  it('truncates stdout at a UTF-8 char boundary (no replacement char)', async () => {
    // '中' is 3 bytes; a 4-byte cap fits exactly one and rolls back the partial second char.
    // The naive subarray(0,4).toString() would emit U+FFFD instead.
    const r = await spawnJyeooFetch({
      binaryPath: process.execPath,
      args: ['-e', 'process.stdout.write("中".repeat(10))'],
      timeoutMs: 5000,
      maxStdoutBytes: 4,
      maxStderrBytes: 100_000,
    });
    const out = r.lines.join('');
    expect(r.stdoutTruncated).toBe(true);
    expect(out).not.toContain('�');
    expect(out).toBe('中');
    expect('中'.repeat(10).startsWith(out)).toBe(true);
  });

  it('preserves runtime, cookie/account, logging and proxy configuration', async () => {
    const config = {
      PATH: '/usr/bin:/bin',
      HOME: '/fake/home',
      TMPDIR: '/fake/tmpdir',
      TMP: '/fake/tmp',
      TEMP: '/fake/temp',
      LANG: 'C',
      LC_ALL: 'C',
      LC_CTYPE: 'C',
      TZ: 'Asia/Shanghai',
      JYEOO_COOKIES: '/fake/cookies.json',
      JYEOO_API_ACCOUNT: '/fake/api-account.json',
      RUST_LOG: 'jyeoo_rs=debug',
      HTTP_PROXY: 'http://proxy.invalid:8080',
      HTTPS_PROXY: 'http://proxy.invalid:8081',
      ALL_PROXY: 'socks5://proxy.invalid:1080',
      NO_PROXY: 'localhost,127.0.0.1,.example.test',
      http_proxy: 'http://lower.invalid:8080',
      https_proxy: 'http://lower.invalid:8081',
      all_proxy: 'socks5://lower.invalid:1080',
      no_proxy: '.lower.test',
    };
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    const probe = `const keys = ${JSON.stringify(Object.keys(config))};
      process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));`;
    const run = (env?: Record<string, string | undefined>) =>
      spawnJyeooFetch({ binaryPath: process.execPath, args: ['-e', probe], env, ...generous });
    const inherited = await run();
    expect(inherited.exitCode).toBe(0);
    expect(JSON.parse(inherited.lines.join(''))).toEqual(config);

    const overrides = {
      JYEOO_COOKIES: '/fake/override.json',
      JYEOO_API_ACCOUNT: undefined,
      HTTPS_PROXY: 'http://override.invalid:9000',
      NO_PROXY: '',
      RUST_LOG: undefined,
    };
    const overridden = await run(overrides);
    expect(overridden.exitCode).toBe(0);
    const { JYEOO_API_ACCOUNT: _account, RUST_LOG: _log, ...remaining } = config;
    expect(JSON.parse(overridden.lines.join(''))).toEqual({
      ...remaining,
      JYEOO_COOKIES: overrides.JYEOO_COOKIES,
      HTTPS_PROXY: overrides.HTTPS_PROXY,
      NO_PROXY: '',
    });
    expect(process.env.JYEOO_COOKIES).toBe(config.JYEOO_COOKIES);
    expect(process.env.RUST_LOG).toBe(config.RUST_LOG);
  });

  it('uses an overridden PATH to resolve the producer and its helpers', async () => {
    vi.stubEnv('PATH', '/nonexistent/fake-path');
    const r = await spawnJyeooFetch({
      binaryPath: 'sh',
      args: ['-c', 'sh -c "printf helper-ok"'],
      env: { PATH: '/usr/bin:/bin' },
      ...generous,
    });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('')).toBe('helper-ok');
  });

  it('rejects non-positive bounds (defensive)', async () => {
    await expect(
      spawnJyeooFetch({ binaryPath: SH, args: ['-c', 'exit 0'], ...generous, timeoutMs: 0 }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      spawnJyeooFetch({ binaryPath: SH, args: ['-c', 'exit 0'], ...generous, maxStdoutBytes: 0 }),
    ).rejects.toThrow(/maxStdoutBytes/);
    await expect(
      spawnJyeooFetch({ binaryPath: SH, args: ['-c', 'exit 0'], ...generous, maxStderrBytes: -1 }),
    ).rejects.toThrow(/maxStderrBytes/);
  });

  it('a process still writing when SIGKILL tears the pipe resolves without crashing', async () => {
    // A continuously-writing child gets SIGKILL'd at the timeout mid-write, tearing the
    // stdout pipe → Node emits 'error' on the stream. Without the stream-level error
    // listeners this would be an uncaughtException that crashes the worker; here the run
    // must resolve cleanly with the timeout disposition.
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      args: ['-c', 'while true; do printf "x\\n"; done'],
      timeoutMs: 150,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 100_000,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe('SIGKILL');
  });
});

describe('sliceToCharBoundary', () => {
  it('rolls a mid-sequence cut back to a UTF-8 char boundary', () => {
    const buf = Buffer.from('中中', 'utf8'); // 6 bytes (3 each)
    expect(sliceToCharBoundary(buf, 4).toString('utf8')).toBe('中'); // cut inside 2nd char
    expect(sliceToCharBoundary(buf, 3).toString('utf8')).toBe('中'); // exact 1-char boundary
    expect(sliceToCharBoundary(buf, 6).toString('utf8')).toBe('中中'); // exact full
    expect(sliceToCharBoundary(buf, 100).toString('utf8')).toBe('中中'); // over → full
  });

  it('leaves ASCII untouched', () => {
    expect(sliceToCharBoundary(Buffer.from('abcdef'), 3).toString('utf8')).toBe('abc');
  });
});
