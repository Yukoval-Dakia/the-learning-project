import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('./codex-stop-edit-check.mjs', import.meta.url).pathname;

const runHook = (cwd) =>
  spawnSync('node', [hook], {
    cwd,
    encoding: 'utf8',
  });

const parseStdoutJson = (result) => JSON.parse(result.stdout);

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-stop-edit-check-'));
  execFileSync('git', ['init', '-b', 'hooktest'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'codex@example.test'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), '{"ok":true}\n');
  writeFileSync(join(dir, 'example.ts'), 'export const ok = true;\n');
  execFileSync('git', ['add', 'package.json', 'example.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });
  const baseline = runHook(dir);
  assert.equal(baseline.status, 0);
  assert.equal(parseStdoutJson(baseline).suppressOutput, true);
  return dir;
};

test('blocks invalid JSON changed after baseline', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'package.json'), '{bad\n');

  const result = runHook(repo);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"decision":"block"/);
  assert.match(result.stdout, /JSON invalid after edit/);
  assert.equal(parseStdoutJson(result).decision, 'block');
});

test('does not run Biome or block for changed TypeScript files', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'example.ts'), 'export  const badlySpaced = true\n');

  const result = runHook(repo);

  assert.equal(result.status, 0);
  assert.equal(parseStdoutJson(result).suppressOutput, true);
  assert.equal(result.stderr, '');
});
