import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The YUK-914 pipeline contract, asserted on the committed pipeline text: the
// seed step exists only behind the manual SUPPLY_SEED=1 condition, the
// required offline gate runs on every normal build (never soft-fail), and the
// registry drift observation is advisory (soft_fail) and never gates success.

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '../..');

async function pipelineText() {
  return readFile(join(repoRoot, '.buildkite', 'pipeline.yml'), 'utf8');
}

function stepBlock(text: string, key: string) {
  const start = text.indexOf(`key: ${key}`);
  expect(start, `pipeline.yml must define step key ${key}`).toBeGreaterThan(0);
  const nextStep = text.indexOf('  - label:', start);
  return text.slice(start, nextStep === -1 ? undefined : nextStep);
}

describe('.buildkite/pipeline.yml supply-chain gate wiring', () => {
  it('gates the seed step behind the manual SUPPLY_SEED=1 condition', async () => {
    const seed = stepBlock(await pipelineText(), 'supply-seed');
    expect(seed).toContain('if: build.env("SUPPLY_SEED") == "1"');
    expect(seed).toContain('supply-seed.sh');
    expect(seed).not.toContain('soft_fail');
  });

  it('runs the required offline gate on every normal build without soft_fail', async () => {
    const gate = stepBlock(await pipelineText(), 'supply-offline-gate');
    expect(gate).toContain('if: build.env("SUPPLY_SEED") != "1"');
    expect(gate).toContain('supply-consume.sh');
    expect(gate).not.toContain('soft_fail');
  });

  it('keeps the registry drift observation advisory via soft_fail', async () => {
    const drift = stepBlock(await pipelineText(), 'supply-registry-drift');
    expect(drift).toContain('soft_fail: true');
    expect(drift).toContain('supply-drift-observe.sh');
    expect(drift).not.toMatch(/if: build\.env/);
  });

  it('makes the imported job subset wait on the required offline gate', async () => {
    const text = await pipelineText();
    const importer = stepBlock(text, 'github-actions-import');
    expect(importer).toContain('depends_on: supply-offline-gate');
    expect(importer).not.toContain('depends_on: verify-build-context');
  });
});
