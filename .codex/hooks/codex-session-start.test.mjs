import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('./codex-session-start.mjs', import.meta.url).pathname;

const runHook = (cwd) =>
  spawnSync('node', [hook], {
    cwd,
    encoding: 'utf8',
  });

const statePath = (root) => {
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
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
  assert.equal(typeof state.hashes['package.json'], 'string');
  assert.equal(existsSync(statePath(root)), true);
});
