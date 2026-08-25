// Runtime artifact pins for the YUK-914 offline supply-chain gate.
//
// `runtime-artifact-pins.json` has two platform states and both are fail-closed:
//
//   1. bootstrap  — `{ "seedRequired": true }`. A lead must run the manual
//      `SUPPLY_SEED=1` seed build and record its receipt digests in a reviewed
//      commit. The required offline gate hard-fails on this state.
//   2. pinned     — `{ archiveSha256, manifestSha256, seedBuild }`. The required
//      gate downloads the digest-named closure and loader from that prior build
//      via `buildkite-agent artifact download … --build <seedBuild>`.
//
// All-zero or placeholder digests are rejected outright: they were the pre-YUK-914
// placeholder shape and must never validate.

import { readFile } from 'node:fs/promises';
import { SupplyContractError, parseLooseJson } from './supply-graph.mjs';

const ZERO_SHA256 = '0'.repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUILDKITE_BUILD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PINS_SCHEMA_VERSION = 1;
export const SEED_RECEIPT_METADATA_KEY = 'supply-seed-receipt';

/**
 * @typedef {object} PinnedPlatform
 * @property {string} archiveSha256
 * @property {string} manifestSha256
 * @property {string} seedBuild
 */

function parsePlatformEntry(key, entry) {
  if (entry && entry.seedRequired === true) return { key, seedRequired: true };
  const archiveSha256 = entry?.archiveSha256;
  const manifestSha256 = entry?.manifestSha256;
  const seedBuild = entry?.seedBuild;
  if (entry && 'seedRequired' in entry) {
    throw new SupplyContractError(
      `runtime artifact pins platform ${key} carries seedRequired: ${String(entry.seedRequired)}; ` +
        'a platform is either the bootstrap { "seedRequired": true } or fully pinned digests',
    );
  }
  for (const [field, value] of [
    ['archiveSha256', archiveSha256],
    ['manifestSha256', manifestSha256],
  ]) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
      throw new SupplyContractError(
        `runtime artifact pins platform ${key} has a malformed or missing ${field} digest`,
      );
    }
    if (value === ZERO_SHA256) {
      throw new SupplyContractError(
        `runtime artifact pins platform ${key} still carries the all-zero placeholder ${field} digest; ` +
          'run the SUPPLY_SEED=1 seed build and record its receipt digests instead',
      );
    }
  }
  if (typeof seedBuild !== 'string' || !BUILDKITE_BUILD_ID_PATTERN.test(seedBuild)) {
    throw new SupplyContractError(
      `runtime artifact pins platform ${key} is missing the immutable Buildkite UUID seedBuild to download from`,
    );
  }
  return { key, seedRequired: false, archiveSha256, manifestSha256, seedBuild };
}

export async function loadPins(pinsPath) {
  const pins = parseLooseJson(await readFile(pinsPath, 'utf8'));
  if (pins?.schemaVersion !== PINS_SCHEMA_VERSION) {
    throw new SupplyContractError(
      `runtime artifact pins schemaVersion must be ${PINS_SCHEMA_VERSION}`,
    );
  }
  const approved = pins.approvedRuntimePlugin;
  if (
    typeof approved?.package !== 'string' ||
    typeof approved.version !== 'string' ||
    typeof approved.ownerSpecifier !== 'string'
  ) {
    throw new SupplyContractError('runtime artifact pins are missing approvedRuntimePlugin');
  }
  const pipeline = pins.artifactSource?.pipeline;
  if (typeof pipeline !== 'string' || pipeline.length === 0) {
    throw new SupplyContractError(
      'runtime artifact pins are missing artifactSource.pipeline (the pipeline that seeds the artifacts)',
    );
  }
  const platforms = pins.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new SupplyContractError('runtime artifact pins are missing platforms');
  }
  const parsed = {};
  for (const [key, entry] of Object.entries(platforms)) {
    parsed[key] = parsePlatformEntry(key, entry);
  }
  return { ...pins, artifactSource: { pipeline }, platforms: parsed };
}

export function isSeedRequired(platformEntry) {
  return platformEntry?.seedRequired === true;
}

/**
 * The required offline gate's platform lookup: throws on bootstrap and missing
 * states so an unseeded repository is a hard RED, never a silent skip.
 * @param {Awaited<ReturnType<typeof loadPins>>} pins
 * @returns {PinnedPlatform}
 */
export function requirePinnedPlatform(pins, key) {
  const entry = pins.platforms[key];
  if (!entry) {
    throw new SupplyContractError(`no pinned runtime artifact digests for ${key}`);
  }
  if (isSeedRequired(entry)) {
    throw new SupplyContractError(
      `runtime artifact pins for ${key} are in the bootstrap state (seedRequired): ` +
        'a lead must run the manual SUPPLY_SEED=1 seed build and record its receipt ' +
        '(archiveSha256, manifestSha256, seedBuild) in .buildkite/supply/runtime-artifact-pins.json',
    );
  }
  return entry;
}

export function closureArtifactName(archiveSha256) {
  return `runtime-closure-${archiveSha256}.tar.gz`;
}

export function loaderArtifactName(platform, arch) {
  return `opencode-loader-${platform}-${arch}.tgz`;
}

/**
 * Exact argv for the cross-build artifact download the required gate runs.
 * A numeric build number needs an explicit pipeline scope even when the source
 * pipeline matches the current pipeline; otherwise the agent treats it as a
 * build UUID and requests `/builds/<number>`.
 */
export function buildArtifactDownloadArgs({
  artifactName,
  destination,
  build,
  pipeline,
  currentPipeline,
}) {
  void currentPipeline;
  return [
    'artifact',
    'download',
    artifactName,
    destination,
    '--build',
    String(build),
    '--pipeline',
    pipeline,
  ];
}

/** The pinned loader integrity recorded in bun.lock for the platform binary package. */
export function bunLockLoaderIntegrity(bunLockText, platform, arch, version) {
  const lock = parseLooseJson(bunLockText);
  const name = `opencode-${platform}-${arch}`;
  const row = lock?.packages?.[name];
  if (!Array.isArray(row) || row[0] !== `${name}@${version}`) {
    throw new SupplyContractError(
      `bun.lock has no ${name}@${version} resolution to pin the loader binary`,
    );
  }
  return row[row.length - 1];
}

const RECEIPT_KIND = 'supply-seed-receipt';

/**
 * Builds the machine-readable seed receipt emitted by the SUPPLY_SEED=1 step.
 * Validates the same invariants the pins will enforce when the lead records it.
 */
export function buildSeedReceipt(fields) {
  for (const [field, value] of [
    ['archiveSha256', fields.archiveSha256],
    ['manifestSha256', fields.manifestSha256],
  ]) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value) || value === ZERO_SHA256) {
      throw new SupplyContractError(`seed receipt ${field} must be a real non-zero sha256 digest`);
    }
  }
  if (typeof fields.loaderIntegrity !== 'string' || !fields.loaderIntegrity.startsWith('sha512-')) {
    throw new SupplyContractError(
      'seed receipt loaderIntegrity must be a sha512-… integrity value',
    );
  }
  const receipt = {
    kind: RECEIPT_KIND,
    schemaVersion: PINS_SCHEMA_VERSION,
    platform: fields.platform,
    arch: fields.arch,
    pipeline: fields.pipeline,
    buildNumber: fields.buildNumber,
    gitHead: fields.gitHead,
    seededAt: fields.seededAt,
    archiveSha256: fields.archiveSha256,
    manifestSha256: fields.manifestSha256,
    loaderIntegrity: fields.loaderIntegrity,
    loaderSpecifier: fields.loaderSpecifier,
    closureArtifact: closureArtifactName(fields.archiveSha256),
    loaderArtifact: loaderArtifactName(fields.platform, fields.arch),
  };
  for (const [key, value] of Object.entries(receipt)) {
    if (value === undefined || value === null || value === '') {
      throw new SupplyContractError(`seed receipt field ${key} is missing`);
    }
  }
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export const SEED_RECEIPT_KIND = RECEIPT_KIND;
