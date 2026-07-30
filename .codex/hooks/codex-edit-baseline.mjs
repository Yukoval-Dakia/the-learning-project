import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const STATE_DIR = join(tmpdir(), 'codex-repo-hook-state');
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const readHookEvent = () => {
  try {
    const input = readFileSync(0, 'utf8').trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
};

export const sessionIdFrom = (event) => {
  const value = event?.session_id ?? event?.sessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : 'legacy-session';
};

export const repoRoot = () => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
};

export const statePath = (root, sessionId) => {
  const id = createHash('sha256')
    .update(root)
    .update('\0')
    .update(sessionId)
    .digest('hex')
    .slice(0, 24);
  return join(STATE_DIR, `${id}.json`);
};

const nulList = (command, args, cwd) => {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
};

export const changedFiles = (root) => {
  const tracked = nulList(
    'git',
    ['diff', '--name-only', '-z', '--diff-filter=ACMR', 'HEAD', '--'],
    root,
  );
  const untracked = nulList('git', ['ls-files', '--others', '--exclude-standard', '-z'], root);
  return [...new Set([...tracked, ...untracked])];
};

export const fileHash = (root, file) => {
  const path = resolve(root, file);
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};

export const currentHashes = (root) =>
  Object.fromEntries(
    changedFiles(root)
      .map((file) => [file, fileHash(root, file)])
      .filter((entry) => entry[1] !== null),
  );

export const readBaseline = (root, sessionId) => {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root, sessionId), 'utf8'));
    if (
      parsed?.root === root &&
      parsed?.sessionId === sessionId &&
      parsed?.hashes &&
      typeof parsed.hashes === 'object'
    ) {
      return parsed.hashes;
    }
  } catch {
    // Missing or corrupt state means this session has no usable baseline yet.
  }
  return null;
};

export const writeBaseline = (root, sessionId, hashes) => {
  const path = statePath(root, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify(
      {
        root,
        sessionId,
        hashes,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  renameSync(temporary, path);
};

export const pruneExpiredBaselines = (now = Date.now()) => {
  if (!existsSync(STATE_DIR)) return;
  for (const entry of readdirSync(STATE_DIR)) {
    const path = join(STATE_DIR, entry);
    try {
      if (now - statSync(path).mtimeMs > STATE_TTL_MS) unlinkSync(path);
    } catch {
      // Cleanup is best effort and must not break session startup.
    }
  }
};
