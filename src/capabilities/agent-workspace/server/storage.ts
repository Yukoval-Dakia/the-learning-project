import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { invokeWorkspace } from './executor';

// Workspace facts live half in Postgres (lease/state/quota) and half on the
// executor volume under `root`. The launcher binary only exists in the worker
// image; every caller gates on `launcherAvailable` so API/dev processes fail
// with workspace_unavailable instead of a spawn ENOENT.
const root = '/var/lib/tlp/workspaces';
const launcher = '/usr/local/libexec/workspace-launch';

export async function launcherAvailable(): Promise<boolean> {
  try {
    await access(launcher, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identity of the mounted volume this process sees. A workspace row bound to a
 * different id is never rebound here: recovery starts a new generation, it does
 * not attach foreign directories.
 */
export async function volumeIdentity(): Promise<string> {
  const identity = `${root}/.identity`;
  await mkdir(identity, { recursive: true, mode: 0o700 });
  const directory = await open(
    identity,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await directory.stat();
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error('workspace_storage_identity_unsafe');
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        `${identity}/id`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(randomBytes(32).toString('hex'));
      await file.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await file?.close();
    }
    const value = await readFile(`${identity}/id`, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(value.trim())) throw new Error('workspace_storage_identity_invalid');
    return value.trim();
  } finally {
    await directory.close();
  }
}

export async function workspaceBytes(id: string): Promise<number> {
  const result = await invokeWorkspace('usage', id, '');
  if (result.exitCode !== 0) throw new Error(`workspace_usage_failed: ${result.output}`);
  const bytes: unknown = JSON.parse(result.output).bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error('workspace_usage_invalid');
  return bytes;
}

/**
 * Pool usage is summed over launcher-scanned directories only. An unrecognized
 * entry fails closed: quota checks then refuse new writes rather than ignore
 * bytes a sandboxed script may have planted at the root.
 */
export async function poolBytes(): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.identity') continue;
    if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('workspace_pool_unrecognized_entry');
    bytes += await workspaceBytes(entry.name);
  }
  return bytes;
}

/**
 * Runtime identity of the token holder: container (hostname), host boot,
 * PID-1 start (container incarnation), and the claimant pid. Same host+boot+init
 * but a dead pid means the claimant is provably gone; a different hostname is
 * not proof — another machine could share the volume.
 */
export async function runtimeIdentity(): Promise<string> {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const init = await readFile('/proc/1/stat', 'utf8');
  const start = init.slice(init.lastIndexOf(')') + 2).split(' ')[19];
  return `${hostname()}:${boot}:${start}:${process.pid}`;
}

export async function previousClaimEnded(previous: string): Promise<boolean> {
  const [host, boot, init, pid] = previous.split(':');
  const current = await runtimeIdentity();
  const [nowHost, nowBoot, nowInit] = current.split(':');
  if (host !== nowHost) return false;
  if (boot !== nowBoot || init !== nowInit) return true;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
