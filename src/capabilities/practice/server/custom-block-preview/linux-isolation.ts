import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PreviewError, type PreviewLimits } from './types';

const CGROUP_ROOT = '/sys/fs/cgroup/tlp-custom-preview';
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Only invoked by a preview operation. Imports perform no filesystem or process work. */
export async function createLinuxIsolation(limits: PreviewLimits) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) {
    throw new PreviewError('isolation_unavailable', 'nonroot_linux_required');
  }
  let temporary: string | undefined;
  let cgroup: string | undefined;
  try {
    await Promise.all([
      access('/usr/bin/unshare', constants.X_OK),
      access('/usr/bin/timeout', constants.X_OK),
      access('/bin/sh', constants.X_OK),
      access(join(CGROUP_ROOT, 'cgroup.subtree_control'), constants.W_OK),
    ]);
    const root = await realpath(CGROUP_ROOT);
    if (
      root !== CGROUP_ROOT ||
      relative('/sys/fs/cgroup', root).startsWith('..') ||
      (await statfs(root)).type !== 0x63677270
    ) {
      throw new Error('invalid cgroup root');
    }
    if (
      !(await readFile(join(root, 'cgroup.subtree_control'), 'utf8'))
        .split(/\s+/)
        .includes('memory')
    ) {
      throw new Error('memory controller not delegated');
    }
    temporary = await mkdtemp(join(tmpdir(), 'tlp-custom-preview-'));
    cgroup = join(root, temporary.slice(temporary.lastIndexOf('/') + 1));
    await mkdir(cgroup);
    // All descendants inherit this hard kernel ceiling, including renderer/native allocations.
    // No RSS sampling or V8 heap flag is used as a substitute.
    await writeFile(join(cgroup, 'memory.max'), String(limits.memory_bytes));
    await writeFile(join(cgroup, 'memory.swap.max'), '0');
    await writeFile(join(cgroup, 'memory.oom.group'), '1');
    await access(join(cgroup, 'cgroup.kill'), constants.W_OK);
    for (const [name, expected] of [
      ['memory.max', String(limits.memory_bytes)],
      ['memory.swap.max', '0'],
      ['memory.oom.group', '1'],
    ]) {
      if ((await readFile(join(cgroup, name), 'utf8')).trim() !== expected) {
        throw new Error('cgroup limit readback mismatch');
      }
    }
    const launcher = join(temporary, 'launch.sh');
    // Executed as /bin/sh <script> ...; no chmod or hard-coded file permissions.
    // Browser args are positional argv, never interpolated into shell source.
    await writeFile(
      launcher,
      'set -eu\n' +
        'preview_group=$1; preview_seconds=$2; shift 2\n' +
        'printf "%s\\n" "$$" > "$preview_group/cgroup.procs"\n' +
        'exec /usr/bin/timeout --signal=KILL --kill-after=1s "$preview_seconds" ' +
        '/usr/bin/unshare --user --map-current-user --net --pid --mount-proc --fork --kill-child=KILL "$@"\n',
    );
    const profile = join(temporary, 'profile');
    const scratch = join(temporary, 'tmp');
    await mkdir(profile);
    await mkdir(scratch);
    const fixedGroup = cgroup;
    const fixedTemporary = temporary;
    return {
      launcher,
      cgroup: fixedGroup,
      profile,
      env: { PATH: '/usr/bin:/bin', HOME: fixedTemporary, TMPDIR: scratch, LANG: 'C.UTF-8' },
      async kill() {
        await writeFile(join(fixedGroup, 'cgroup.kill'), '1');
      },
      async memoryExceeded() {
        const events = await readFile(join(fixedGroup, 'memory.events'), 'utf8');
        return events.split('\n').some((line) => /^(max|oom|oom_kill) [1-9]\d*$/.test(line));
      },
      async confirmSandbox(executable: string) {
        const ids = (await readFile(join(fixedGroup, 'cgroup.procs'), 'utf8')).trim().split(/\s+/);
        const processes = await Promise.all(
          ids.filter(Boolean).map(async (pid) => {
            try {
              const base = `/proc/${pid}`;
              const [cmd, status, user, net] = await Promise.all([
                readFile(join(base, 'cmdline'), 'utf8'),
                readFile(join(base, 'status'), 'utf8'),
                readlink(join(base, 'ns/user')),
                readlink(join(base, 'ns/net')),
              ]);
              return { args: cmd.split('\0'), status, user, net };
            } catch {
              return null; // exited process; absence never counts as confirmation
            }
          }),
        );
        const browser = processes.find(
          (p) => p?.args[0] === executable && !p.args.some((a) => a.startsWith('--type=')),
        );
        const renderers = processes.filter((p) => p?.args.includes('--type=renderer'));
        const hostNet = await readlink('/proc/self/ns/net');
        const filters = (s: string) => Number(/^Seccomp_filters:\s*(\d+)$/m.exec(s)?.[1] ?? 0);
        // Chromium may nest the zygote/renderer network namespace inside the browser's.
        // Independently require every checked process to remain outside the worker host net.
        if (
          !browser ||
          renderers.length === 0 ||
          browser.net === hostNet ||
          renderers.some(
            (p) =>
              !p ||
              p.net === hostNet ||
              p.user === browser.user ||
              !/^NoNewPrivs:\s*1$/m.test(p.status) ||
              !/^Seccomp:\s*2$/m.test(p.status) ||
              filters(p.status) <= filters(browser.status),
          )
        ) {
          throw new PreviewError('sandbox_unconfirmed', 'renderer_kernel_sandbox_unconfirmed');
        }
      },
      async cleanup() {
        await writeFile(join(fixedGroup, 'cgroup.kill'), '1');
        const until = Date.now() + limits.ready_ms;
        while (/^populated 1$/m.test(await readFile(join(fixedGroup, 'cgroup.events'), 'utf8'))) {
          if (Date.now() >= until)
            throw new PreviewError('cleanup_failed', 'cgroup_still_populated');
          await pause(20);
        }
        await rmdir(fixedGroup);
        await rm(fixedTemporary, { recursive: true });
      },
    };
  } catch (error) {
    // No browser is launched until this preparation has completed.
    const cleanup = await Promise.allSettled([
      ...(cgroup ? [rmdir(cgroup)] : []),
      ...(temporary ? [rm(temporary, { recursive: true })] : []),
    ]);
    if (cleanup.some((result) => result.status === 'rejected')) {
      throw new PreviewError('cleanup_failed', 'prelaunch_cleanup_failed');
    }
    if (error instanceof PreviewError) throw error;
    throw new PreviewError('isolation_unavailable', 'linux_cgroup_or_namespace_prerequisite');
  }
}
