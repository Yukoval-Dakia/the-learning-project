import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDbManifest } from './db-artifact-manifest.mjs';

function gitSha(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) continue;
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command !== 'build') throw new Error(`unknown command: ${command ?? '(missing)'}`);

  const root = process.cwd();
  const selectionPath = path.resolve(options.selection ?? '.cache/ci/db-selection.json');
  const outputPath = path.resolve(options.output ?? '.cache/ci/db-manifest.json');
  const shardCount = Number.parseInt(options.shards ?? '2', 10);
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`invalid --shards value: ${options.shards ?? '(missing)'}`);
  }

  const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  const manifest = buildDbManifest({
    selection,
    shardCount,
    workspace: { root, selectionPath, manifestPath: outputPath },
    build: {
      buildkite_build_number: process.env.BUILDKITE_BUILD_NUMBER ?? null,
      pipeline_slug: process.env.BUILDKITE_PIPELINE_SLUG ?? null,
      branch: process.env.BUILDKITE_BRANCH ?? null,
    },
    head: gitSha(root, ['rev-parse', 'HEAD']),
    tree: gitSha(root, ['rev-parse', 'HEAD^{tree}']),
    now: new Date(),
  });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    JSON.stringify({
      manifest_path: outputPath,
      mode: manifest.mode,
      selected_files: manifest.selected_files.length,
      shards: manifest.shards.count,
      digest_sha256: manifest.digest_sha256,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
