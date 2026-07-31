#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const readEvent = () => {
  try {
    const input = readFileSync(0, 'utf8').trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
};

const event = readEvent();
const file = event?.tool_input?.file_path;

if (typeof file !== 'string' || !file || !existsSync(file)) process.exit(0);

const extension = extname(file);

if (extension === '.json') {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`JSON invalid: ${file}: ${error.message}\n`);
  }
  process.exit(0);
}

if (!['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extension)) process.exit(0);

const result = spawnSync(
  'pnpm',
  ['exec', 'biome', 'check', '--no-errors-on-unmatched', file],
  {
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    encoding: 'utf8',
  },
);

const output = `${result.stdout || ''}${result.stderr || ''}`
  .split('\n')
  .slice(0, 40)
  .join('\n')
  .trim();
if (output) process.stderr.write(`${output}\n`);
