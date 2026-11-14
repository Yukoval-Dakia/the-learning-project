// Outbound/credential guard installed into owned-runtime child processes before
// the workload module loads. Two jobs: (1) module-resolution fallback — an
// out-of-repo case file imports bare specifiers (postgres, drizzle-orm) that
// resolve only inside this worktree's node_modules, so on ERR_MODULE_NOT_FOUND
// we retry with parentURL pinned to the repo root; (2) confinement — loopback
// TCP is allowed only to the owned PG/API ports, outbound fetch and $HOME/.*
// credential reads are denied. Everything is recorded to guard-audit.jsonl.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const repoBase = process.env.OWNED_REPO_BASE;
if (repoBase) {
  const fallbackParent = `${pathToFileURL(repoBase).href}/owned-case-entry.mjs`;
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        const bare =
          !specifier.startsWith('.') &&
          !specifier.startsWith('/') &&
          !specifier.startsWith('file:') &&
          !specifier.startsWith('node:') &&
          !specifier.startsWith('@/') &&
          !specifier.startsWith('#');
        if (error.code === 'ERR_MODULE_NOT_FOUND' && bare) {
          return next(specifier, { ...context, parentURL: fallbackParent });
        }
        throw error;
      }
    },
  });
}

const pgPort = Number(process.env.OWNED_PG_PORT);
const apiPort = Number(process.env.OWNED_API_PORT);
const audit = `${process.env.OWNED_OUT}/guard-audit.jsonl`;
const record = (v) =>
  fs.appendFileSync(
    audit,
    `${JSON.stringify({ pid: process.pid, time: new Date().toISOString(), ...v })}\n`,
  );
record({ kind: 'guard_loaded', allowedPgPort: pgPort, allowedApiPort: apiPort });

const allowedPorts = new Set([pgPort, apiPort].filter((p) => Number.isInteger(p) && p > 0));
function check(args) {
  let first = args[0];
  if (Array.isArray(first)) {
    args = first;
    first = args[0];
  }
  const opts =
    typeof first === 'object'
      ? first
      : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const hostOk = ['127.0.0.1', 'localhost', '::1'].includes(opts.host ?? 'localhost');
  if (!(hostOk && allowedPorts.has(Number(opts.port)))) {
    record({
      kind: 'network_denied',
      transport: typeof first === 'string' ? 'unix' : 'tcp',
      stack: new Error().stack,
    });
    throw Error('FORBIDDEN_NETWORK_DESTINATION');
  }
  record({ kind: 'owned_loopback_connect', port: Number(opts.port) });
}
for (const [obj, key] of [
  [net, 'connect'],
  [net, 'createConnection'],
  [tls, 'connect'],
  [net.Socket.prototype, 'connect'],
]) {
  const real = obj[key];
  obj[key] = function (...args) {
    check(args);
    return real.apply(this, args);
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, ...args) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    allowedPorts.has(Number(url.port))
  ) {
    return realFetch(input, ...args);
  }
  record({ kind: 'fetch_denied', url: url.href });
  throw Error('FORBIDDEN_FETCH_PROVIDER_OR_EXTERNAL');
};

const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const requested = typeof first === 'object' ? Number(first?.port) : Number(first);
  if (Number.isInteger(requested) && allowedPorts.has(requested)) {
    if (typeof first === 'object') args[0] = { ...first, host: '127.0.0.1' };
    else args[1] = '127.0.0.1';
    record({ kind: 'owned_loopback_listen', port: requested });
    return realListen.apply(this, args);
  }
  record({ kind: 'listen_denied', arg: first });
  throw Error('FORBIDDEN_LISTEN');
};

function isCredentialPath(path) {
  const value =
    path instanceof URL
      ? path.pathname
      : typeof path === 'string'
        ? path
        : Buffer.isBuffer(path)
          ? path.toString()
          : '';
  return typeof value === 'string' && process.env.HOME && value.startsWith(`${process.env.HOME}/.`);
}
for (const [obj, keys] of [
  [fs, ['readFileSync', 'readFile', 'openSync', 'open']],
  [fsp, ['readFile', 'open']],
]) {
  for (const key of keys) {
    const real = obj[key];
    obj[key] = function (path, ...rest) {
      if (isCredentialPath(path)) {
        record({ kind: 'credential_file_denied' });
        throw Error('FORBIDDEN_CREDENTIAL_FILE_READ');
      }
      return real.call(this, path, ...rest);
    };
  }
}
syncBuiltinESMExports();
