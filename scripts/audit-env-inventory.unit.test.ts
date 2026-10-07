import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectEnvInventory, missingEnvSchemaKeys } from './audit-env-inventory';

describe('collectEnvInventory', () => {
  it('finds direct, computed, mapped, and ProcessEnv parameter reads', () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'env-inventory-'));
    for (const directory of ['src', 'server', 'scripts']) mkdirSync(join(root, directory));
    writeFileSync(
      join(root, 'src', 'consumer.ts'),
      `const DIRECT = process.env.DIRECT_KEY;
const DYNAMIC_KEY = 'DYNAMIC_KEY';
const MAP = { a: 'MAPPED_A_KEY', b: 'MAPPED_B_KEY' } as const;
const selected = MAP[Math.random() > 0.5 ? 'a' : 'b'];
const dynamic = process.env[DYNAMIC_KEY] ?? process.env[selected];
export function read(env: NodeJS.ProcessEnv = process.env) { return env.INDIRECT_KEY; }
`,
    );

    // When
    const inventory = collectEnvInventory(root);

    // Then
    expect(inventory.get('src/consumer.ts')).toEqual(
      new Set(['DIRECT_KEY', 'DYNAMIC_KEY', 'MAPPED_A_KEY', 'MAPPED_B_KEY', 'INDIRECT_KEY']),
    );
  });

  it('excludes test-support helpers while preserving adjacent production consumers', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-inventory-'));
    for (const directory of ['src', 'server', 'scripts']) mkdirSync(join(root, directory));
    for (const [file, key] of [
      ['telemetry.sdk.test-support.ts', 'SDK_TEST_ONLY_KEY'],
      ['telemetry.test.ts', 'TEST_ONLY_KEY'],
      ['telemetry.ts', 'PRODUCTION_KEY'],
      ['telemetry.support.ts', 'REAL_SUPPORT_KEY'],
    ])
      writeFileSync(join(root, 'src', file), `const value = process.env.${key};`);
    const inventory = collectEnvInventory(root);
    expect([...inventory.keys()]).toEqual(['src/telemetry.support.ts', 'src/telemetry.ts']);
    expect(missingEnvSchemaKeys(inventory, new Set())).toEqual([
      'PRODUCTION_KEY (src/telemetry.ts)',
      'REAL_SUPPORT_KEY (src/telemetry.support.ts)',
    ]);
  });

  it('reports every consumed key absent from the schema', () => {
    // Given
    const inventory = new Map([['src/consumer.ts', new Set(['DECLARED_KEY', 'MISSING_KEY'])]]);

    // When
    const missing = missingEnvSchemaKeys(inventory, new Set(['DECLARED_KEY']));

    // Then
    expect(missing).toEqual(['MISSING_KEY (src/consumer.ts)']);
  });
});
