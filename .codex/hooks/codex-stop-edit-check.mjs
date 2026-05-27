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

const statePath = (root) => {
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(tmpdir(), 'codex-repo-hook-state', `${id}.json`);
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

const changedFiles = (root) => {
  const tracked = nulList(
    'git',
    ['diff', '--name-only', '-z', '--diff-filter=ACMR', 'HEAD', '--'],
    root,
  );
  const untracked = nulList('git', ['ls-files', '--others', '--exclude-standard', '-z'], root);
  return [...new Set([...tracked, ...untracked])];
};

const fileHash = (root, file) => {
  const path = resolve(root, file);
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};

const readBaseline = (root) => {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root), 'utf8'));
    if (parsed?.root === root && parsed?.hashes && typeof parsed.hashes === 'object') {
      return parsed.hashes;
    }
  } catch {
    // Missing or corrupt state just means this is the first stop after enabling the hook.
  }
  return null;
};

const writeBaseline = (root, hashes) => {
  const path = statePath(root);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ root, hashes }, null, 2));
};

const stopOk = () => {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
  process.exit(0);
};

const stopWithFeedback = (reason) => {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
      systemMessage: 'Repo stop check failed. Fix the reported JSON issue before replying.',
    }),
  );
  process.exit(0);
};

const main = () => {
  const root = repoRoot();
  process.chdir(root);

  const currentFiles = changedFiles(root);
  const currentHashes = Object.fromEntries(
    currentFiles.map((file) => [file, fileHash(root, file)]).filter((entry) => entry[1] !== null),
  );

  const baseline = readBaseline(root);
  if (baseline === null) {
    writeBaseline(root, currentHashes);
    stopOk();
  }

  const filesToCheck = currentFiles.filter((file) => {
    const hash = currentHashes[file];
    return hash && baseline[file] !== hash;
  });

  const jsonFiles = filesToCheck.filter((file) => file.endsWith('.json'));

  for (const file of jsonFiles) {
    try {
      JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    } catch (err) {
      stopWithFeedback(`JSON invalid after edit: ${file}: ${err.message}`);
    }
  }

  writeBaseline(root, currentHashes);
  stopOk();
};

main();
