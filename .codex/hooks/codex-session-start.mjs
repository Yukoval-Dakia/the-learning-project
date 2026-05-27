#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = () => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
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

const statePath = (root) => {
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(tmpdir(), 'codex-repo-hook-state', `${id}.json`);
};

const fileHash = (root, file) => {
  const path = resolve(root, file);
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};

const changedFiles = (root) => {
  const tracked = nulList(
    'git',
    ['diff', '--name-only', '-z', '--diff-filter=ACMR', 'HEAD', '--'],
    root,
  );
  const untracked = nulList('git', ['ls-files', '--others', '--exclude-standard', '-z'], root);
  return [...new Set([...tracked, ...untracked])];
};

const writeBaseline = () => {
  try {
    const root = repoRoot();
    const hashes = {};
    for (const file of changedFiles(root)) {
      const hash = fileHash(root, file);
      if (hash) hashes[file] = hash;
    }
    const path = statePath(root);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ root, hashes }, null, 2));
  } catch {
    // Session context injection should not fail because the baseline helper did.
  }
};

const sessionStartOk = () => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '',
      },
    }),
  );
};

writeBaseline();
sessionStartOk();
