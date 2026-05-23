#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readStdin = () =>
  new Promise((resolveRead) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolveRead(data));
  });

const feedback = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
};

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

const touchedFiles = (patch) => {
  const files = new Set();
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) files.add(match[1]);
  }
  return [...files];
};

const firstLines = (text, limit = 40) => text.split(/\r?\n/).slice(0, limit).join('\n');

const main = async () => {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  if (event?.tool_name !== 'apply_patch') process.exit(0);
  const command = event?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const root = repoRoot();
  process.chdir(root);

  const files = touchedFiles(command).filter((file) => existsSync(resolve(root, file)));
  for (const file of files.filter((path) => path.endsWith('.json'))) {
    try {
      JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    } catch (err) {
      feedback(`JSON invalid after edit: ${file}: ${err.message}`);
    }
  }

  const lintable = files.filter((path) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(path));
  if (lintable.length === 0) process.exit(0);

  try {
    execFileSync('pnpm', ['exec', 'biome', 'check', '--no-errors-on-unmatched', ...lintable], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
    feedback(firstLines(output || `Biome check failed for ${lintable.join(', ')}`));
  }
};

main().catch(() => process.exit(0));
