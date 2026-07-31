import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('./codex-stop-edit-check.mjs', import.meta.url).pathname;
const sessionStartHook = new URL('./codex-session-start.mjs', import.meta.url).pathname;

const runHook = (cwd, sessionId = 'session-a') =>
  spawnSync('node', [hook], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId }),
  });

const runSessionStart = (cwd, sessionId, source = 'startup') =>
  spawnSync('node', [sessionStartHook], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId, source }),
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
  const baseline = runSessionStart(dir, 'session-a');
  assert.equal(baseline.status, 0);
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

test('another session startup cannot overwrite this session baseline', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'package.json'), '{bad\n');

  const otherSession = runSessionStart(repo, 'session-b');
  const result = runHook(repo, 'session-a');

  assert.equal(otherSession.status, 0);
  assert.equal(parseStdoutJson(result).decision, 'block');
  assert.match(parseStdoutJson(result).reason, /JSON invalid after edit/);
});

test('resume with a missing baseline validates existing dirty JSON before adoption', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'package.json'), '{bad\n');

  const resumed = runSessionStart(repo, 'missing-baseline', 'resume');
  const result = runHook(repo, 'missing-baseline');

  assert.equal(resumed.status, 0);
  assert.equal(parseStdoutJson(result).decision, 'block');
  assert.match(parseStdoutJson(result).reason, /JSON invalid after edit/);
});
