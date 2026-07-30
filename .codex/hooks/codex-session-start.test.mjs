import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('./codex-session-start.mjs', import.meta.url).pathname;

const runHook = (cwd, event = { session_id: 'session-a', source: 'startup' }) =>
  spawnSync('node', [hook], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify(event),
  });

const statePath = (root, sessionId = 'session-a') => {
  const id = createHash('sha256')
    .update(root)
    .update('\0')
    .update(sessionId)
    .digest('hex')
    .slice(0, 24);
  return join(tmpdir(), 'codex-repo-hook-state', `${id}.json`);
};

const repoRoot = (cwd) =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-session-start-'));
  execFileSync('git', ['init', '-b', 'hooktest'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'codex@example.test'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), '{"ok":true}\n');
  execFileSync('git', ['add', 'package.json'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });
  return dir;
};

test('records baseline and returns valid SessionStart hook JSON', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'package.json'), '{"ok":false}\n');

  const result = runHook(repo);
  const root = repoRoot(repo);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '',
    },
  });

  const state = JSON.parse(readFileSync(statePath(root), 'utf8'));
  assert.equal(state.root, root);
  assert.equal(state.sessionId, 'session-a');
  assert.equal(typeof state.hashes['package.json'], 'string');
  assert.equal(existsSync(statePath(root)), true);
});

test('resume keeps the existing baseline for the same session', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'package.json'), '{"step":1}\n');
  runHook(repo);

  const root = repoRoot(repo);
  const before = JSON.parse(readFileSync(statePath(root), 'utf8'));
  writeFileSync(join(repo, 'package.json'), '{"step":2}\n');

  const result = runHook(repo, { session_id: 'session-a', source: 'resume' });
  const after = JSON.parse(readFileSync(statePath(root), 'utf8'));

  assert.equal(result.status, 0);
  assert.deepEqual(after.hashes, before.hashes);
});
