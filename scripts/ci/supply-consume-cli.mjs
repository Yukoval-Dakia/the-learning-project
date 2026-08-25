import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquirePinnedArtifacts } from './supply-acquire.mjs';
import { consumeArtifact } from './supply-artifact-consume.mjs';
import { parseLooseJson } from './supply-graph.mjs';
import { buildOfflineWorkspaceTemplate } from './supply-offline.mjs';
import { loadPins } from './supply-pins.mjs';

function argValue(args, flag, fallback) {
  const prefix = `${flag}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function requireArg(args, flag, required) {
  const value = argValue(args, flag, null);
  if (required && !value) {
    throw new Error(
      'usage: supply-consume-cli.mjs --archive=<tar[.gz]> --loader=<opencode-binary> [--repo=.] [--pins=…] | --from-pins',
    );
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const fromPins = args.includes('--from-pins');
  const repoRoot = resolve(argValue(args, '--repo', process.cwd()));
  const pinsPath = resolve(
    argValue(args, '--pins', join(repoRoot, '.buildkite', 'supply', 'runtime-artifact-pins.json')),
  );
  const inventory = parseLooseJson(
    await readFile(
      join(repoRoot, '.opencode', 'plugins', 'supply-chain', 'inventory.json'),
      'utf8',
    ),
  );
  const bunLockText = await readFile(join(repoRoot, '.opencode', 'plugins', 'bun.lock'), 'utf8');
  const runRoot = await mkdtemp(join(tmpdir(), 'supply-consume-'));
  const workspaceTemplateDir = await buildOfflineWorkspaceTemplate({
    root: runRoot,
    repoRoot,
    inventory,
  });
  try {
    let archivePath = requireArg(args, '--archive', !fromPins);
    let loaderPath = requireArg(args, '--loader', !fromPins);
    if (fromPins) {
      const pins = await loadPins(pinsPath);
      ({ archivePath, loaderPath } = await acquirePinnedArtifacts({
        pins,
        platform: process.platform,
        arch: process.arch,
        downloadDir: join(runRoot, 'artifacts'),
        extractRoot: join(runRoot, 'loader'),
        currentPipeline: process.env.BUILDKITE_PIPELINE_SLUG,
        bunLockText,
        loaderVersion: inventory.opencode.version,
        runAgent: (argv) => execFileSync('buildkite-agent', argv, { stdio: 'inherit' }),
      }));
    }
    const summary = await consumeArtifact({
      archivePath,
      loaderPath,
      pinsPath,
      inventory,
      bunLockText,
      workspaceTemplateDir,
      scratchRoot: join(runRoot, 'consume'),
    });
    console.log(
      `offline supply-chain verification passed: archive ${summary.archiveSha256.slice(0, 12)}…, ` +
        `${summary.tools.length} required tools registered, ${summary.networkAttempts} network attempts.`,
    );
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

await main();
