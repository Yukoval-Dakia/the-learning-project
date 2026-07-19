import { describe, expect, it } from 'vitest';
import { sliceToCharBoundary, spawnJyeooFetch } from './jyeoo-spawn';

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

  it('passes env vars through and drops undefined entries', async () => {
    const r = await spawnJyeooFetch({
      binaryPath: SH,
      args: ['-c', 'printf "%s" "$JYEOO_TEST_VAR"'],
      env: { JYEOO_TEST_VAR: 'hi', JYEOO_UNSET: undefined },
      timeoutMs: 5000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 100_000,
    });
    expect(r.lines.join('')).toBe('hi');
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
