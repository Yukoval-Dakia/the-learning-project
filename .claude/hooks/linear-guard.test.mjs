import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, 'linear-guard.mjs');

const makeLinearRepo = () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'linear-guard-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['checkout', '-b', 'yuk-28-test'], {
    cwd: repo,
    stdio: 'ignore',
  });
  return repo;
};

const runHook = (command) =>
  spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });

test('blocks magic-word shorthand that Linear only links to the first issue', () => {
  const repo = makeLinearRepo();
  const result = runHook(
    `git -C ${repo} commit -m "docs: update" -m "Closes YUK-27 + YUK-28"`,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /repeat the magic keyword/i);
});

test('allows multiple issues when each issue repeats the Linear magic keyword', () => {
  const repo = makeLinearRepo();
  const result = runHook(
    `git -C ${repo} commit -m "docs: update" -m "Closes YUK-27" -m "Closes YUK-28"`,
  );

  assert.equal(result.status, 0, result.stderr);
});

test('still blocks Linear-tracked branch commits with no YUK reference', () => {
  const repo = makeLinearRepo();
  const result = runHook(`git -C ${repo} commit -m "docs: update"`);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /lacks a YUK-NN reference/);
});
