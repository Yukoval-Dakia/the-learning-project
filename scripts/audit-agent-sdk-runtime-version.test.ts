import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LOCKFILE = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

const PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function importerVersion(packageName: (typeof PACKAGES)[number]): string {
  const match = LOCKFILE.match(
    new RegExp(
      `^      '${escapeRegex(packageName)}':\\n        specifier: [^\\n]+\\n        version: ([^\\s(]+)`,
      'm',
    ),
  );
  if (!match?.[1]) throw new Error(`root lockfile importer has no resolved ${packageName}`);
  return match[1];
}

function dockerPin(packageName: (typeof PACKAGES)[number]): string {
  const match = DOCKERFILE.match(new RegExp(`^\\s*${escapeRegex(packageName)}@([^\\s\\\\]+)`, 'm'));
  if (!match?.[1]) throw new Error(`Dockerfile sdkdeps has no exact ${packageName} pin`);
  return match[1];
}

describe('production Agent SDK runtime version', () => {
  it.each(PACKAGES)('%s matches the root lockfile resolution', (packageName) => {
    expect(dockerPin(packageName)).toBe(importerVersion(packageName));
  });
});
