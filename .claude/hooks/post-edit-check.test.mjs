import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hook = new URL('./post-edit-check.mjs', import.meta.url).pathname;

const runHook = (filePath) =>
  spawnSync('node', [hook], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
  });

test('reports invalid JSON without failing the PostToolUse hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'post-edit-check-'));
  const file = join(dir, 'invalid.json');
  writeFileSync(file, '{bad\n');

  const result = runHook(file);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /JSON invalid:/);
});

test('accepts valid JSON silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'post-edit-check-'));
  const file = join(dir, 'valid.json');
  writeFileSync(file, '{"ok":true}\n');

  const result = runHook(file);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});
