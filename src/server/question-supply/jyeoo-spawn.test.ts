import { describe, expect, it } from 'vitest';
import { spawnJyeooFetch } from './jyeoo-spawn';

// These exercise the REAL bounded-subprocess machinery against tiny fake producers
// (/bin/sh + node one-liners). No DB — valid unit partition.
const SH = '/bin/sh';
const generous = { timeoutMs: 5000, maxStdoutBytes: 1_000_000, maxStderrBytes: 100_000 };

describe('spawnJyeooFetch', () => {
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
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      args: ['-c', 'sleep 5'],
      timeoutMs: 100,
      maxStdoutBytes: 1_000_000,
      maxStderrBytes: 100_000,
    });
    expect(r.timedOut).toBe(true);
    // SIGKILL leaves a null exit code + the signal name.
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBe('SIGKILL');
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
});
