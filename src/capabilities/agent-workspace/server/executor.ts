import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const launcher = '/usr/local/libexec/workspace-launch';
const outputLimit = 100 * 1024;
// This ceiling only stops loops/errors; no model task is admitted by this slice.
const timeoutMs = 30 * 60 * 1000;
type StopReason = 'timeout' | 'cancelled' | 'output_limit' | null;

function invoke(action: string, id: string, code: string, signal?: AbortSignal) {
  return new Promise<{
    exitCode: number | null;
    output: string;
    stopped: boolean;
    stopReason: StopReason;
  }>((resolve, reject) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_workspace');
    signal?.throwIfAborted();
    const child = spawn(launcher, [action, id], {
      cwd: '/',
      env: {},
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopReason: StopReason = null;
    const stop = (reason: Exclude<StopReason, null>) => {
      if (stopReason !== null) return;
      stopReason = reason;
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM');
        } catch (error) {
          // The fixed supervisor drops its identity only to reap the group.
          // EPERM can race that final drop after the interpreter has exited.
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH' && code !== 'EPERM') reject(error);
        }
      }
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunk: Buffer) => {
      const available = outputLimit - bytes;
      chunks.push(chunk.subarray(0, available));
      bytes += Math.min(available, chunk.length);
      if (chunk.length > available) stop('output_limit');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {
      /* Early interpreter exit may close stdin. */
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    child.once('exit', () => {
      // A detached descendant can retain the pipes after the supervisor exits.
      // Bound draining separately so it cannot keep the tool promise alive.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    });
    child.once('close', (exitCode) => {
      clearTimeout(drainTimer);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        output: Buffer.concat(chunks).toString('utf8'),
        stopped: stopReason !== null,
        stopReason,
      });
    });
    child.stdin.end(code);
    if (signal?.aborted) onAbort();
  });
}

export async function executeWorkspace(
  runtime: 'bash' | 'python',
  code: string,
  signal?: AbortSignal,
) {
  if (Buffer.byteLength(code, 'utf8') > 100 * 1024) throw new Error('workspace_code_too_large');
  const id = randomBytes(32).toString('hex');
  signal?.throwIfAborted();
  const created = await invoke('create', id, '');
  if (created.exitCode !== 0) throw new Error(`workspace_create_failed: ${created.output}`);
  let result: Awaited<ReturnType<typeof invoke>> | undefined;
  let failure: unknown;
  try {
    result = await invoke(runtime, id, code, signal);
  } catch (error) {
    failure = error;
  }
  // Cancellation must not cancel cleanup. Preserve both failures if cleanup also fails.
  try {
    const removed = await invoke('remove', id, '');
    if (removed.exitCode !== 0) throw new Error(`workspace_cleanup_failed: ${removed.output}`);
  } catch (error) {
    throw new AggregateError(failure ? [failure, error] : [error], 'workspace_cleanup_failed');
  }
  if (!result) throw failure;
  return result;
}
