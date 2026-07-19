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

// A bounded byte accumulator: collects raw Buffer chunks up to `cap` bytes WITHOUT any
// mid-stream decode, so a multibyte UTF-8 char that spans two chunks is never split (the
// full byte sequence is decoded ONCE at the end). At the cap we slice the overflowing
// chunk back to a UTF-8 char boundary so truncation can't emit a replacement char.
class BoundedByteSink {
  private readonly chunks: Buffer[] = [];
  private used = 0;
  truncated = false;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    if (this.used + chunk.length <= this.cap) {
      this.chunks.push(chunk);
      this.used += chunk.length;
      return;
    }
    const room = this.cap - this.used;
    if (room > 0) this.chunks.push(sliceToCharBoundary(chunk, room));
    this.used = this.cap;
    this.truncated = true;
  }

  decode(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

// Truncate a Buffer to at most `maxBytes`, rolling the cut point back so it never lands
// inside a multibyte UTF-8 sequence (a continuation byte is 0b10xxxxxx = 0x80..0xBF). This
// is the real fix the bot's suggested `subarray(0, n).toString()` does NOT provide — that
// re-decode still yields U+FFFD when the cut splits a char.
export function sliceToCharBoundary(buf: Buffer, maxBytes: number): Buffer {
  let end = Math.min(maxBytes, buf.length);
  // Roll back while the byte AT the cut is a UTF-8 continuation byte (0b10xxxxxx), i.e.
  // the cut lands inside a multibyte sequence; stop at the first lead/ASCII byte.
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return buf.subarray(0, end);
}

/**
 * Spawn jyeoo-rs with bounded stdout/stderr + a hard timeout. Never rejects on a
 * non-zero exit — the disposition (exitCode/signal/timedOut) is returned for the
 * adapter to classify. Rejects ONLY on a spawn-level OS error (ENOENT etc.) or invalid
 * bounds, which the handler treats as a terminal 'spawn' failure.
 */
export function spawnJyeooFetch(opts: SpawnJyeooOptions): Promise<SpawnJyeooResult> {
  // Defensive bounds validation — a non-positive cap/timeout is a caller bug (a 0-byte
  // cap would truncate everything; a 0ms timeout would kill instantly), so fail loudly
  // rather than silently produce an empty/misclassified batch.
  for (const [name, value] of [
    ['timeoutMs', opts.timeoutMs],
    ['maxStdoutBytes', opts.maxStdoutBytes],
    ['maxStderrBytes', opts.maxStderrBytes],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return Promise.reject(
        new Error(`spawnJyeooFetch: ${name} must be a positive finite number (got ${value})`),
      );
    }
  }

  return new Promise<SpawnJyeooResult>((resolve, reject) => {
    // Merge env over process.env, DROPPING undefined values — an undefined entry in
    // opts.env would otherwise unset (or stringify to "undefined") an inherited var.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
      if (v !== undefined) childEnv[k] = v;
    }
    // Default stdio (all piped) → ChildProcessWithoutNullStreams, so stdout/stderr are
    // non-null for capture. stdin is piped but unused (we never write to it).
    const spawnOpts: SpawnOptionsWithoutStdio = { cwd: opts.cwd, env: childEnv };
    const child = spawn(opts.binaryPath, opts.args, spawnOpts);

    // Raw-byte sinks (no mid-stream decode → no cross-chunk boundary splits).
    const stdoutSink = new BoundedByteSink(opts.maxStdoutBytes);
    const stderrSink = new BoundedByteSink(opts.maxStderrBytes);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      // Timeout race guard: if the child has ALREADY produced an exit disposition, the
      // 'close' handler is merely queued behind this timer — flagging a timeout + SIGKILL
      // here would misclassify a clean exit as a timeout and trigger a false retry. Only
      // kill a process that is genuinely still running.
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      // SIGKILL: a wedged scraper may ignore SIGTERM; we want a hard stop.
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutSink.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrSink.push(chunk));

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
        lines: stdoutSink.decode().split('\n'),
        stdoutTruncated: stdoutSink.truncated,
        stderr: stderrSink.decode(),
        stderrTruncated: stderrSink.truncated,
      });
    });
  });
}
