// YUK-914 advisory registry-drift observation. This step is deliberately NOT
// part of the required gate: it reports what the live registry would resolve
// today for the packages whose open ranges caused the original drift, stores
// the observation as Buildkite metadata, and always exits 0.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OBSERVED_PACKAGES = [
  '@opencode-ai/plugin',
  '@cortexkit/opencode-magic-context',
  '@zenobius/opencode-skillful',
  'oh-my-openagent',
];

async function registryLatest(name) {
  const { stdout } = await execFileAsync('npm', ['view', name, 'version', '--json'], {
    timeout: 30_000,
  });
  const version = JSON.parse(stdout);
  return typeof version === 'string' ? version : String(version.at(-1));
}

async function main() {
  const args = process.argv.slice(2);
  const repoRoot = resolve(
    args.find((arg) => arg.startsWith('--repo='))?.slice(7) ?? process.cwd(),
  );
  const pins = JSON.parse(
    await readFile(join(repoRoot, '.buildkite', 'supply', 'runtime-artifact-pins.json'), 'utf8'),
  );
  const observed = {
    observedAt: new Date().toISOString(),
    approved: pins.approvedRuntimePlugin,
    packages: {},
  };
  for (const name of OBSERVED_PACKAGES) {
    try {
      observed.packages[name] = { latest: await registryLatest(name) };
    } catch (error) {
      observed.packages[name] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const approvedPlugin = observed.packages[pins.approvedRuntimePlugin.package];
  observed.drifted = Boolean(
    approvedPlugin?.latest && approvedPlugin.latest !== pins.approvedRuntimePlugin.version,
  );
  const record = JSON.stringify(observed, null, 2);
  console.log(record);
  if (observed.drifted) {
    console.log(
      `advisory: registry would resolve ${pins.approvedRuntimePlugin.package}@${approvedPlugin.latest} ` +
        `but the approved runtime closure pins ${pins.approvedRuntimePlugin.version}; ` +
        'the required offline gate is unaffected. Start a reviewed refresh when the drift matters.',
    );
  }
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('buildkite-agent', ['meta-data', 'set', 'supply-registry-observation', record], {
      stdio: 'ignore',
    });
  } catch {
    // No agent (local run): the console record above is the whole observation.
  }
}

await main();
