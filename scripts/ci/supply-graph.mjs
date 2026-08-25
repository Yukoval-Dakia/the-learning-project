// Supply-chain graph contracts for the YUK-914 offline runtime artifact.
//
// The graph row/hash algorithms mirror `.opencode/plugins/supply-chain/inventory.ts`
// (which stays Bun-typed and untouched): rows are [path, name, version, integrity]
// tuples sorted by path, and the graph digest is the SHA-256 of their JSON form.
// This module is plain Node so pipeline steps can run it without Bun.

import { createHash } from 'node:crypto';

export const MANIFEST_KIND = 'opencode-runtime-closure';
export const MANIFEST_SCHEMA_VERSION = 1;

export class SupplyContractError extends Error {}

export function closureDirName(specifier) {
  return specifier.replaceAll('/', '__');
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * Parses JSON whose only extension is trailing commas (bun.lock's dialect).
 * Commas inside string literals are preserved.
 */
export function parseLooseJson(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (lookahead >= text.length || text[lookahead] === ']' || text[lookahead] === '}') continue;
    }
    output += character;
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new SupplyContractError(`loose JSON parse failed: ${error.message}`);
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseResolution(resolution) {
  const separator = resolution.lastIndexOf('@');
  if (separator <= 0) throw new SupplyContractError(`invalid lock resolution: ${resolution}`);
  return { name: resolution.slice(0, separator), version: resolution.slice(separator + 1) };
}

export function bunLockResolutions(bunLockText) {
  const lock = parseLooseJson(bunLockText);
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new SupplyContractError('bun.lock is missing its packages table');
  }
  const resolutions = new Set();
  for (const value of Object.values(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
    const integrity = value[value.length - 1];
    if (typeof integrity !== 'string' || !integrity.startsWith('sha')) continue;
    const resolution = parseResolution(value[0]);
    resolutions.add(JSON.stringify([resolution.name, resolution.version, integrity]));
  }
  if (resolutions.size === 0)
    throw new SupplyContractError('bun.lock contains no integrity resolutions');
  return resolutions;
}

export function runtimeGraphRows(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new SupplyContractError('runtime package-lock is missing packages');
  }
  const rows = [];
  for (const [rawPath, value] of Object.entries(packages)) {
    if (rawPath === '') continue;
    const marker = rawPath.indexOf('node_modules/');
    if (marker < 0) throw new SupplyContractError(`unexpected runtime lock path: ${rawPath}`);
    const path = rawPath.slice(marker);
    if (typeof value?.version !== 'string' || typeof value?.integrity !== 'string') {
      throw new SupplyContractError(`runtime lock row lacks version/integrity: ${path}`);
    }
    const nameMarker = path.lastIndexOf('node_modules/');
    rows.push({
      path,
      name: path.slice(nameMarker + 'node_modules/'.length),
      version: value.version,
      integrity: value.integrity,
    });
  }
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return rows;
}

export function runtimeGraphSha256(rows) {
  return sha256Hex(
    JSON.stringify(
      rows.map(({ path, name, version, integrity }) => [path, name, version, integrity]),
    ),
  );
}

function resolutionKey(name, version, integrity) {
  return JSON.stringify([name, version, integrity]);
}

export function validateClosureGraph(lock, plugin, resolutions, approved) {
  const rows = runtimeGraphRows(lock);
  const top = rows.find((row) => row.path === `node_modules/${plugin.package}`);
  if (!top)
    throw new SupplyContractError(`${plugin.specifier} runtime lock is missing its package row`);
  if (top.version !== plugin.version || top.integrity !== plugin.integrity) {
    throw new SupplyContractError(
      `${plugin.package} loaded ${top.version} / ${top.integrity}, approved is ${plugin.version} / ${plugin.integrity}`,
    );
  }
  for (const row of rows) {
    if (!resolutions.has(resolutionKey(row.name, row.version, row.integrity))) {
      throw new SupplyContractError(
        `${plugin.specifier} runtime package is not in bun.lock: ${row.path} -> ${row.name}@${row.version}`,
      );
    }
  }
  if (rows.length !== plugin.runtimePackageCount) {
    throw new SupplyContractError(
      `${plugin.specifier} runtime package count drifted: expected ${plugin.runtimePackageCount}, actual ${rows.length}`,
    );
  }
  const digest = runtimeGraphSha256(rows);
  if (digest !== plugin.runtimeGraphSha256) {
    throw new SupplyContractError(
      `${plugin.specifier} runtime graph drifted: expected ${plugin.runtimeGraphSha256}, actual ${digest}`,
    );
  }
  if (approved && plugin.specifier === approved.ownerSpecifier) {
    const runtimePlugin = rows.find((row) => row.path === `node_modules/${approved.package}`);
    if (runtimePlugin && runtimePlugin.version !== approved.version) {
      throw new SupplyContractError(
        `approved runtime resolution drifted: ${approved.package} expected ${approved.version}, actual ${runtimePlugin.version} in ${approved.ownerSpecifier}`,
      );
    }
  }
  return rows.length;
}

export function buildClosureManifest(fields) {
  const plugins = [...fields.plugins].sort((left, right) =>
    left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0,
  );
  return `${canonicalJson({
    arch: fields.arch,
    entryCount: fields.entryCount,
    kind: fields.kind,
    opencodeVersion: fields.opencodeVersion,
    platform: fields.platform,
    plugins,
    schemaVersion: fields.schemaVersion,
  })}\n`;
}

export function validateManifestAgainstInventory(manifest, inventory, context) {
  if (manifest?.kind !== MANIFEST_KIND) {
    throw new SupplyContractError(`manifest kind is not ${MANIFEST_KIND}`);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new SupplyContractError(`manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.platform !== context.platform || manifest.arch !== context.arch) {
    throw new SupplyContractError(
      `manifest platform mismatch: ${manifest.platform}-${manifest.arch} vs ${context.platform}-${context.arch}`,
    );
  }
  if (manifest.opencodeVersion !== inventory.opencode.version) {
    throw new SupplyContractError(
      `manifest OpenCode version ${manifest.opencodeVersion} does not match inventory ${inventory.opencode.version}`,
    );
  }
  const expected = [...inventory.npmPlugins].map((plugin) => plugin.specifier).sort();
  const actual = (manifest.plugins ?? []).map((plugin) => plugin.specifier).sort();
  if (actual.length !== expected.length || actual.some((spec, index) => spec !== expected[index])) {
    throw new SupplyContractError(
      `manifest plugin set does not match inventory: ${actual.join(', ')}`,
    );
  }
  for (const declared of manifest.plugins ?? []) {
    const plugin = inventory.npmPlugins.find((entry) => entry.specifier === declared.specifier);
    if (
      declared.package !== plugin.package ||
      declared.version !== plugin.version ||
      declared.integrity !== plugin.integrity ||
      declared.runtimePackageCount !== plugin.runtimePackageCount ||
      declared.runtimeGraphSha256 !== plugin.runtimeGraphSha256
    ) {
      throw new SupplyContractError(
        `manifest plugin ${declared.specifier} version ${declared.version} does not match inventory version ${plugin.version}`,
      );
    }
  }
}
