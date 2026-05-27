import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('./codex-bash-workflow-guard.mjs', import.meta.url).pathname;

const runHook = (command, cwd = process.cwd()) =>
  spawnSync('node', [hook], {
    cwd,
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bash-workflow-guard-'));
  execFileSync('git', ['init', '-b', 'hooktest'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'codex@example.test'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), '{"ok":true}\n');
  execFileSync('git', ['add', 'package.json'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });
  return dir;
};

test('blocks full repository gates unless explicitly marked final', () => {
  const blocked = runHook('pnpm lint');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /CODEX_FULL_GATE=1 pnpm lint/);

  const allowed = runHook('CODEX_FULL_GATE=1 pnpm lint');
  assert.equal(allowed.status, 0);
});

test('allows targeted validation commands', () => {
  assert.equal(runHook('pnpm exec biome check src/server/foo.ts').status, 0);
  assert.equal(runHook('pnpm test:unit src/server/foo.test.ts').status, 0);
});

test('blocks broad git add when untracked archive artifacts exist', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'tmp'));
  writeFileSync(join(repo, 'tmp', 'artifact.zip'), 'not really a zip');

  const result = runHook('git add .', repo);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /artifact-like untracked file/);
  assert.match(result.stderr, /tmp\/artifact\.zip/);
});

test('blocks commit when artifact files are already staged', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'artifact.zip'), 'not really a zip');
  execFileSync('git', ['add', 'artifact.zip'], { cwd: repo });

  const result = runHook('git commit -m "test"', repo);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /staged artifact-like file/);
  assert.match(result.stderr, /artifact\.zip/);
});
