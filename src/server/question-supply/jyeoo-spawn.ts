// YUK-697 — bounded jyeoo-rs subprocess I/O.
//
// The producer is spawned as a subprocess whose stdout is NDJSON (one envelope/line)
// and whose logs go to stderr (DESIGN §2: "stdout 只出数据，一切日志走 stderr"). This
// module owns the SAFETY envelope around that spawn: a wall-clock timeout that KILLS a
// wedged producer, and byte caps on stdout/stderr so a runaway producer can never
// exhaust worker memory. It returns raw lines + the exit disposition; parsing +
// classification live in jyeoo-loom-adapter.ts, persistence in the handler.

import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process';

export interface SpawnJyeooOptions {
  binaryPath: string;
  args: string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Extra env for the child (merged over process.env). Cookie path etc. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface SpawnJyeooResult {
  /** Clean exit code, or null when the process was killed by a signal / never exited. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when the wall-clock timeout fired and we killed the process. */
  timedOut: boolean;
  /** stdout split into lines (trailing partial line included; caller trims/parses). */
  lines: string[];
  /** True when stdout hit the byte cap and was truncated (batch is then suspect). */
  stdoutTruncated: boolean;
  /** Captured stderr (for the failure event's diagnostic tail), possibly truncated. */
  stderr: string;
  stderrTruncated: boolean;
}

/** The injectable spawn seam (handler default = real subprocess). */
export type SpawnJyeooFn = (opts: SpawnJyeooOptions) => Promise<SpawnJyeooResult>;

/**
 * Spawn jyeoo-rs with bounded stdout/stderr + a hard timeout. Never rejects on a
 * non-zero exit — the disposition (exitCode/signal/timedOut) is returned for the
 * adapter to classify. Rejects ONLY on a spawn-level OS error (ENOENT etc.), which the
 * handler treats as a terminal 'spawn' failure.
 */
export function spawnJyeooFetch(opts: SpawnJyeooOptions): Promise<SpawnJyeooResult> {
  return new Promise<SpawnJyeooResult>((resolve, reject) => {
    // Default stdio (all piped) → ChildProcessWithoutNullStreams, so stdout/stderr are
    // non-null for capture. stdin is piped but unused (we never write to it).
    const spawnOpts: SpawnOptionsWithoutStdio = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    };
    const child = spawn(opts.binaryPath, opts.args, spawnOpts);

    // stdout — accumulate bounded bytes, split into lines at the end. We keep a rolling
    // byte budget; once exceeded we stop appending and flag truncation.
    let stdoutBuf = '';
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = '';
    let stderrBytes = 0;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL: a wedged scraper may ignore SIGTERM; we want a hard stop.
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdoutTruncated) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes + chunkBytes > opts.maxStdoutBytes) {
        // Append the portion that fits, then stop + flag truncation.
        const remaining = opts.maxStdoutBytes - stdoutBytes;
        if (remaining > 0)
          stdoutBuf += Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8');
        stdoutBytes = opts.maxStdoutBytes;
        stdoutTruncated = true;
        return;
      }
      stdoutBuf += chunk;
      stdoutBytes += chunkBytes;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderrTruncated) return;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes + chunkBytes > opts.maxStderrBytes) {
        const remaining = opts.maxStderrBytes - stderrBytes;
        if (remaining > 0)
          stderr += Buffer.from(chunk, 'utf8').subarray(0, remaining).toString('utf8');
        stderrBytes = opts.maxStderrBytes;
        stderrTruncated = true;
        return;
      }
      stderr += chunk;
      stderrBytes += chunkBytes;
    });

    child.on('error', (err) => {
      // OS-level spawn failure (e.g. ENOENT — binary not on PATH). Terminal.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        lines: stdoutBuf.split('\n'),
        stdoutTruncated,
        stderr,
        stderrTruncated,
      });
    });
  });
}
