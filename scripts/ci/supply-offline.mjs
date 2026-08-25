// Offline execution guard for the YUK-914 required consumer.
//
// The consumer must *prove* the loader ran without network access, not merely
// prefer offline. A loopback sentinel server becomes the npm registry and every
// HTTP(S) proxy for the child process, so any egress attempt lands on it, is
// recorded, and fails the run.

import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closureDirName, parseLooseJson } from './supply-graph.mjs';

export class OfflineGuardError extends Error {}

/**
 * Builds the isolated workspace from the repository's live OpenCode config,
 * restricted to the inventory-approved npm plugins: the local file:// plugin
 * depends on the Bun-installed plugins node_modules, which is outside the
 * offline runtime closure this gate covers (the in-repo verifier owns it).
 */
export async function buildOfflineWorkspaceTemplate({ root, repoRoot, inventory }) {
  const template = join(root, 'template');
  await mkdir(join(template, '.opencode'), { recursive: true });
  const config = parseLooseJson(
    await readFile(join(repoRoot, '.opencode', 'opencode.json'), 'utf8'),
  );
  const approved = new Set(inventory.npmPlugins.map((plugin) => plugin.specifier));
  const plugins = (Array.isArray(config.plugin) ? config.plugin : []).filter(
    (specifier) => typeof specifier === 'string' && approved.has(specifier),
  );
  await writeFile(
    join(template, '.opencode', 'opencode.json'),
    `${JSON.stringify({ ...config, plugin: plugins }, null, 2)}\n`,
  );
  for (const relative of inventory.compatibility?.ohMyOpenagentConfigs ?? []) {
    await cp(join(repoRoot, relative), join(template, relative));
  }
  return template;
}

export async function pointWorkspaceAtExtractedPlugins({
  workspace,
  extractRoot,
  declaredPlugins,
  inventory,
}) {
  const localEntries = [];
  for (const declared of declaredPlugins) {
    const plugin = inventory.npmPlugins.find((entry) => entry.specifier === declared.specifier);
    if (!plugin) {
      throw new OfflineGuardError(`manifest plugin is not inventoried: ${declared.specifier}`);
    }
    const packageRoot = join(
      extractRoot,
      'closure',
      closureDirName(declared.specifier),
      'node_modules',
      plugin.package,
    );
    const packageManifest = parseLooseJson(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    const entryRelative = packageManifest.main ?? packageManifest.module ?? 'index.js';
    if (typeof entryRelative !== 'string') {
      throw new OfflineGuardError(`${declared.specifier} has no string main/module entrypoint`);
    }
    const entryPath = resolve(packageRoot, entryRelative);
    const fromPackage = relative(packageRoot, entryPath);
    if (fromPackage.startsWith('..') || isAbsolute(fromPackage)) {
      throw new OfflineGuardError(`${declared.specifier} entrypoint escapes its package root`);
    }
    await access(entryPath);
    localEntries.push(pathToFileURL(entryPath).href);
  }
  const configPath = join(workspace, '.opencode', 'opencode.json');
  const config = parseLooseJson(await readFile(configPath, 'utf8'));
  await writeFile(configPath, `${JSON.stringify({ ...config, plugin: localEntries }, null, 2)}\n`);
}

export async function startNetworkSentinel() {
  const attempts = [];
  const server = createServer((socket) => {
    const peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
    socket.setTimeout(1_000, () => {
      attempts.push(`${peer} <no-request-bytes>`);
      socket.destroy();
    });
    socket.once('data', (chunk) => {
      const requestLine = chunk.toString('utf8').split(/\r?\n/, 1)[0].slice(0, 500);
      attempts.push(`${peer} ${requestLine}`);
      socket.end('HTTP/1.1 502 Offline\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address !== 'object') {
    server.close();
    throw new OfflineGuardError('network sentinel could not bind a loopback port');
  }
  return {
    port: address.port,
    attempts,
    async stop() {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

export function offlineLoaderEnv(home, sentinelPort) {
  const sentinel = `http://127.0.0.1:${sentinelPort}/`;
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  env.TMPDIR = join(home, 'tmp');
  env.TMP = env.TMPDIR;
  env.TEMP = env.TMPDIR;
  env.DO_NOT_TRACK = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.npm_config_registry = sentinel;
  env.npm_config_offline = 'true';
  env.npm_config_prefer_offline = 'true';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.HTTP_PROXY = sentinel;
  env.HTTPS_PROXY = sentinel;
  env.http_proxy = sentinel;
  env.https_proxy = sentinel;
  env.ALL_PROXY = sentinel;
  env.NO_PROXY = '';
  env.no_proxy = '';
  return env;
}

export async function runLoaderSnapshot(options) {
  const child = spawn(options.loader, ['debug', 'agent', 'build'], {
    cwd: options.workspace,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const timeoutMs = options.timeoutMs ?? 12 * 60_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const exitCode = await new Promise((resolvePromise) => {
    child.once('exit', (code) => resolvePromise(code));
  });
  clearTimeout(timer);
  const stderrText = Buffer.concat(stderr).toString('utf8').slice(-2000);
  if (timedOut) throw new OfflineGuardError(`loader timed out after ${timeoutMs}ms\n${stderrText}`);
  if (exitCode !== 0) {
    throw new OfflineGuardError(`loader exited ${exitCode}\n${stderrText}`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  } catch (error) {
    throw new OfflineGuardError(
      `loader snapshot was not JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  const tools = snapshot?.tools;
  if (!tools || typeof tools !== 'object') {
    throw new OfflineGuardError('loader snapshot did not contain a tools table');
  }
  return snapshot;
}
