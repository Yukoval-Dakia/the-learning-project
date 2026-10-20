import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, unlink, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Shared with the host's heavy.sh: slot-N/owner starts with the holding PID.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('local-heavy requires a shell command');
const ci = ['CI', 'GITHUB_ACTIONS', 'CIRCLECI'].some((key) =>
  /^(1|true)$/i.test(process.env[key] ?? ''),
);
const directory = join(homedir(), '.cache', 'tlp-heavy-slots');
let owned;
let child;
let interrupted;

function signalGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = signal;
    signalGroup(signal);
  });
}

async function ancestors() {
  if (process.platform === 'linux') {
    const result = new Set();
    let pid = process.ppid;
    while (pid > 1 && !result.has(pid)) {
      result.add(pid);
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
    return result;
  }
  const parents = new Map(
    execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number)),
  );
  const result = new Set();
  let pid = process.ppid;
  while (pid > 1 && !result.has(pid)) {
    result.add(pid);
    pid = parents.get(pid);
  }
  return result;
}

async function ownerOf(slot) {
  try {
    return await readFile(join(slot, 'owner'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function acquire() {
  const slots = Number(process.env.HEAVY_SLOTS ?? 2);
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 2) {
    throw new Error('HEAVY_SLOTS must be 1 or 2 on the local host');
  }
  await mkdir(directory, { recursive: true });
  const parents = await ancestors();
  // Check all default slots even when a nested invocation requests only one.
  for (let i = 1; i <= 2; i++) {
    const owner = await ownerOf(join(directory, `slot-${i}`));
    if (owner && parents.has(Number(owner.split(' ')[0]))) {
      console.error(`[local-heavy] reusing ancestor slot-${i}`);
      return;
    }
  }
  let announced = false;
  while (!interrupted) {
    for (let i = 1; i <= slots; i++) {
      const path = join(directory, `slot-${i}`);
      try {
        await mkdir(path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        continue;
      }
      const token = `${process.pid} ${Date.now()} local-heavy\n`;
      owned = { path, token };
      await writeFile(join(path, 'owner'), token, { flag: 'wx' });
      console.error(`[local-heavy] acquired slot-${i}`);
      return;
    }
    if (!announced) {
      console.error(`[local-heavy] waiting for ${directory}; stale slots require owner verification`);
      announced = true;
    }
    await sleep(1000);
  }
}

async function release() {
  if (owned && (await ownerOf(owned.path)) === owned.token) {
    await unlink(join(owned.path, 'owner'));
    await rmdir(owned.path);
  }
}

try {
  if (!ci) await acquire();
  if (!interrupted) {
    const env = { ...process.env };
    if (!ci) {
      // Last occurrence wins; do not let an inherited larger heap defeat the cap.
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --max-old-space-size=3072`.trim();
    }
    // pnpm normally appends CLI arguments to the end of the script. Pass them
    // as shell positional parameters, preserving boundaries and literal bytes.
    child = spawn('/bin/sh', ['-c', `${command}${args.length ? ' "$@"' : ''}`, '--', ...args], {
      env,
      stdio: 'inherit',
      detached: true,
    });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Keep the slot until every process in this command's group has exited.
    while (child.pid) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      await sleep(100);
    }
    process.exitCode = result.code ?? 1;
    interrupted ??= result.signal;
  }
} finally {
  await release();
}
if (interrupted) {
  process.removeAllListeners(interrupted);
  process.kill(process.pid, interrupted);
}
