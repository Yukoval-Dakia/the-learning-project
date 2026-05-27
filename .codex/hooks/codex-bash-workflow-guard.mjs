#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const FULL_GATE_SCRIPTS = new Set(['lint', 'test', 'build']);
const SHELL_OPERATORS = new Set(['|', '||', ';', '&&', '&', '|&']);
const GIT_VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
]);
const GIT_CWD_OPTS = new Set(['-C', '--git-dir', '--work-tree']);
const ARTIFACT_EXTENSIONS = new Set([
  '.7z',
  '.bz2',
  '.dmg',
  '.gz',
  '.iso',
  '.pkg',
  '.rar',
  '.tar',
  '.tgz',
  '.xz',
  '.zip',
]);
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

const readStdin = () =>
  new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });

const block = (msg) => {
  process.stderr.write(`workflow-guard: ${msg}\n`);
  process.exit(2);
};

const tokenize = (cmd) => {
  const tokens = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i += 1;
    if (i >= cmd.length) break;
    let token = '';
    while (i < cmd.length && !/\s/.test(cmd[i])) {
      const char = cmd[i];
      if (char === '"' || char === "'") {
        const quote = char;
        i += 1;
        while (i < cmd.length && cmd[i] !== quote) {
          if (cmd[i] === '\\' && quote === '"' && i + 1 < cmd.length) {
            token += cmd[i + 1];
            i += 2;
          } else {
            token += cmd[i];
            i += 1;
          }
        }
        i += 1;
      } else {
        token += char;
        i += 1;
      }
    }
    tokens.push(token);
  }
  return tokens;
};

const splitSegments = (tokens) => {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
};

const commandStart = (segment) => {
  let i = 0;
  while (i < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(segment[i])) i += 1;
  if (segment[i] === 'env') {
    i += 1;
    while (i < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(segment[i])) i += 1;
  }
  return i;
};

const hasFullGateBypass = (segment) => segment.some((token) => token === 'CODEX_FULL_GATE=1');

const pnpmScript = (segment) => {
  const start = commandStart(segment);
  if (segment[start] !== 'pnpm') return null;

  let i = start + 1;
  if (segment[i] === 'run') i += 1;
  if (!segment[i] || segment[i].startsWith('-')) return null;
  return segment[i];
};

const artifactReason = (root, file) => {
  const ext = path.extname(file).toLowerCase();
  if (ARTIFACT_EXTENSIONS.has(ext)) return 'artifact-like';
  try {
    const stat = statSync(path.resolve(root, file));
    if (stat.isFile() && stat.size >= LARGE_FILE_BYTES) return 'large';
  } catch {
    return null;
  }
  return null;
};

const nulList = (command, args, cwd) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
};

const untrackedFiles = (cwd) =>
  nulList('git', ['ls-files', '--others', '--exclude-standard', '-z'], cwd);

const stagedFiles = (cwd) =>
  nulList('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--'], cwd);

const parseGitInvocation = (segment) => {
  const gitIdx = segment.indexOf('git');
  if (gitIdx === -1) return null;

  let i = gitIdx + 1;
  let cwd = process.cwd();
  while (i < segment.length) {
    const token = segment[i];
    if (!token.startsWith('-')) break;

    if (token.startsWith('--') && token.includes('=')) {
      const [key, value] = token.split(/=(.*)/s);
      if (GIT_CWD_OPTS.has(key) && value) cwd = path.resolve(cwd, value);
      i += 1;
      continue;
    }

    if (GIT_VALUE_OPTS.has(token)) {
      const value = segment[i + 1];
      if (GIT_CWD_OPTS.has(token) && value) cwd = path.resolve(cwd, value);
      i += 2;
      continue;
    }

    i += 1;
  }

  if (i >= segment.length) return null;
  return { cwd, subcommand: segment[i], args: segment.slice(i + 1) };
};

const isBroadGitAdd = (args) =>
  args.some((arg) => arg === '.' || arg === '-A' || arg === '--all' || arg === ':/');

const blockFullGates = (segments) => {
  for (const segment of segments) {
    const script = pnpmScript(segment);
    if (!script || !FULL_GATE_SCRIPTS.has(script) || hasFullGateBypass(segment)) continue;
    block(
      `refused full repository gate \`pnpm ${script}\` during ordinary work.\nPrefer targeted validation while iterating.\nIf this is the deliberate final gate, run:\n  CODEX_FULL_GATE=1 pnpm ${script}`,
    );
  }
};

const blockArtifactStaging = (segments) => {
  for (const segment of segments) {
    const invocation = parseGitInvocation(segment);
    if (!invocation) continue;

    if (invocation.subcommand === 'add') {
      for (const arg of invocation.args.filter((value) => !value.startsWith('-'))) {
        if (existsSync(path.resolve(invocation.cwd, arg)) && artifactReason(invocation.cwd, arg)) {
          block(`refused to stage artifact-like file \`${arg}\`.`);
        }
      }

      if (!isBroadGitAdd(invocation.args)) continue;
      const artifacts = untrackedFiles(invocation.cwd).filter((file) =>
        artifactReason(invocation.cwd, file),
      );
      if (artifacts.length > 0) {
        block(
          `refused broad git add with artifact-like untracked file(s): ${artifacts.join(', ')}.\nStage intentional source files explicitly, or move artifacts outside the repo.`,
        );
      }
    }

    if (invocation.subcommand === 'commit') {
      const artifacts = stagedFiles(invocation.cwd).filter((file) =>
        artifactReason(invocation.cwd, file),
      );
      if (artifacts.length > 0) {
        block(
          `refused commit with staged artifact-like file(s): ${artifacts.join(', ')}.\nUnstage or move generated artifacts before committing.`,
        );
      }
    }
  }
};

const main = async () => {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  const command = event?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const segments = splitSegments(tokenize(command));
  blockFullGates(segments);
  blockArtifactStaging(segments);
};

main().catch(() => process.exit(0));
