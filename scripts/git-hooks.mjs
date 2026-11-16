#!/usr/bin/env node
// Repo-local pre-commit install/uninstall. The hook checks staged blobs only.
// It does not change git config, the index, or the worktree.

import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

const MARKER = 'tlp-managed-git-hook: pre-commit';
const HOOK = `#!/bin/sh
# ${MARKER}
set -eu
root=$(git rev-parse --show-toplevel)
cd "$root"
exec node ./scripts/git-hooks.mjs pre-commit
`;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: Buffer, stderr: Buffer }>}
 */
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

/**
 * @param {string} root
 * @param {string[]} args
 */
async function gitStdout(root, args) {
  const result = await run('git', args, root);
  if (result.code !== 0) {
    const detail = result.stderr.toString('utf8').trim();
    throw new Error(detail || `git ${args[0]} failed`);
  }
  return result.stdout;
}

async function repoRoot() {
  const result = await run('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (result.code !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || '不在 git 仓库里');
  }
  return result.stdout.toString('utf8').trim();
}

/**
 * @param {string} root
 * @returns {Promise<{ kind: 'unset' } | { kind: 'set', origin: string, value: string }>}
 */
async function hooksPathState(root) {
  const result = await run('git', ['config', '--show-origin', '--get', 'core.hooksPath'], root);
  if (result.code === 1) return { kind: 'unset' };
  if (result.code !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || '无法读取 core.hooksPath');
  }
  const line = result.stdout.toString('utf8').trim();
  const tab = line.indexOf('\t');
  if (tab < 0) return { kind: 'set', origin: 'unknown', value: line };
  return { kind: 'set', origin: line.slice(0, tab), value: line.slice(tab + 1) };
}

/**
 * @param {string} root
 */
async function hookFile(root) {
  const common = (await gitStdout(root, ['rev-parse', '--git-common-dir'])).toString('utf8').trim();
  const dir = isAbsolute(common) ? common : join(root, common);
  const file = join(dir, 'hooks', 'pre-commit');
  if (!file.endsWith(`${sep}hooks${sep}pre-commit`)) {
    throw new Error(`意外的 hook 路径：${file}`);
  }
  return file;
}

/**
 * @param {string} text
 */
function isManaged(text) {
  const lines = text.split('\n');
  return lines[0] === '#!/bin/sh' && lines[1] === `# ${MARKER}`;
}

/**
 * @param {string} file
 * @returns {Promise<{ kind: 'absent' | 'current' | 'stale' | 'foreign', path: string }>}
 */
async function hookFileState(file) {
  try {
    const text = await readFile(file, 'utf8');
    if (!isManaged(text)) return { kind: 'foreign', path: file };
    return { kind: text === HOOK ? 'current' : 'stale', path: file };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'absent', path: file };
    }
    throw error;
  }
}

/**
 * @param {string} file
 */
async function writeHook(file) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tlp-tmp`;
  await writeFile(tmp, HOOK);
  const info = await stat(tmp);
  // Git skips a non-executable hook. Keep the umask-applied mode and add +x.
  await chmod(tmp, (info.mode & 0o777) | 0o111);
  await rename(tmp, file);
}

/**
 * @param {string} root
 */
async function install(root) {
  const hooks = await hooksPathState(root);
  if (hooks.kind === 'set') {
    console.error(
      `拒绝安装：core.hooksPath 已设置（${hooks.origin} ${hooks.value}），不修改 git 配置。`,
    );
    process.exitCode = 1;
    return;
  }
  const file = await hookFile(root);
  const state = await hookFileState(file);
  if (state.kind === 'foreign') {
    console.error(`拒绝安装：${state.path} 不是本仓库管理的 hook。`);
    process.exitCode = 1;
    return;
  }
  if (state.kind === 'current') {
    console.log(`pre-commit 已安装：${state.path}`);
    return;
  }
  await writeHook(state.path);
  console.log(`已安装 pre-commit：${state.path}`);
}

/**
 * @param {string} root
 */
async function uninstall(root) {
  const state = await hookFileState(await hookFile(root));
  if (state.kind === 'absent') {
    console.log('pre-commit 未安装');
    return;
  }
  if (state.kind === 'foreign') {
    console.error(`拒绝卸载：${state.path} 不是本仓库管理的 hook。`);
    process.exitCode = 1;
    return;
  }
  await rm(state.path);
  console.log(`已移除 pre-commit：${state.path}`);
}

/**
 * @param {string} path
 */
function isSafePath(path) {
  if (path.length === 0 || path.charAt(0) === '/' || /[\n\r\0]/.test(path)) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/**
 * `biome check --staged` reads the worktree, so partial unstaged edits fail the
 * commit and index-only errors disappear. Index blobs are checked in a temp tree.
 * @param {Buffer} buffer
 * @returns {{ kind: 'ok', paths: string[] } | { kind: 'bad-raw' } | { kind: 'unsafe', path: string }}
 */
function parseStaged(buffer) {
  /** @type {string[]} */
  const parts = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index === buffer.length || buffer[index] === 0) {
      parts.push(buffer.toString('utf8', start, index));
      start = index + 1;
    }
  }
  if (parts.at(-1) === '') parts.pop();

  /** @type {string[]} */
  const paths = [];
  for (let index = 0; index < parts.length; ) {
    const header = parts[index];
    index += 1;
    const fields = header.split(' ');
    const pathSlot = parts[index];
    if (fields.length < 5 || pathSlot === undefined) return { kind: 'bad-raw' };
    const status = fields[4];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const path = renamed ? parts[index + 1] : pathSlot;
    index += renamed ? 2 : 1;
    if (path === undefined) return { kind: 'bad-raw' };
    if (status.startsWith('D') || status.startsWith('U')) continue;
    if (fields[1] !== '100644' && fields[1] !== '100755') continue;
    if (!isSafePath(path)) return { kind: 'unsafe', path };
    paths.push(path);
  }
  return { kind: 'ok', paths };
}

/**
 * @param {string} root
 * @param {string} path
 */
async function readBlob(root, path) {
  const result = await run('git', ['cat-file', 'blob', `:0:${path}`], root);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || `无法读取暂存内容 ${path}`);
  }
  return result.stdout;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {Buffer} bytes
 */
async function writeUnder(root, rel, bytes) {
  const dest = join(root, rel);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!dest.startsWith(prefix)) throw new Error(`拒绝写出临时目录：${rel}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
}

/**
 * Explicit paths exit 1 when every path is ignored, so a dist-only or text-only
 * commit would be blocked even though `biome check .` allows it.
 * @param {string} biome
 * @param {string} cwd
 */
async function checkWithBiome(biome, cwd) {
  const result = await run(biome, ['check', '--files-ignore-unknown=true', '.'], cwd);
  if (result.code === 0) return 0;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

/**
 * @param {string} root
 */
async function checkStaged(root) {
  const parsed = parseStaged(
    await gitStdout(root, ['diff', '--cached', '--raw', '-z', '--no-color']),
  );
  if (parsed.kind === 'bad-raw') {
    console.error('pre-commit 无法解析暂存列表，未修改工作区或索引。');
    process.exitCode = 1;
    return;
  }
  if (parsed.kind === 'unsafe') {
    console.error(`pre-commit 拒绝检查不安全路径 ${parsed.path}，未修改工作区或索引。`);
    process.exitCode = 1;
    return;
  }
  if (parsed.paths.length === 0) return;

  const biome = join(root, 'node_modules', '.bin', 'biome');
  try {
    await access(biome);
  } catch {
    console.error('pre-commit 找不到 node_modules/.bin/biome。先运行 pnpm install。');
    process.exitCode = 1;
    return;
  }

  const temp = await mkdtemp(join(tmpdir(), 'tlp-pre-commit-'));
  try {
    await writeUnder(temp, 'biome.jsonc', await readBlob(root, 'biome.jsonc'));
    for (const path of parsed.paths) {
      await writeUnder(temp, path, await readBlob(root, path));
    }
    const failed = await checkWithBiome(biome, temp);
    if (failed === 0) return;
    console.error('pre-commit 未通过。检查的是暂存内容，工作区和索引没有改动。');
    process.exitCode = failed;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  const root = await repoRoot();
  const command = process.argv[2];
  if (command === 'install') return install(root);
  if (command === 'uninstall') return uninstall(root);
  if (command === 'pre-commit') return checkStaged(root);
  console.error('用法：node scripts/git-hooks.mjs <install|uninstall|pre-commit>');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
