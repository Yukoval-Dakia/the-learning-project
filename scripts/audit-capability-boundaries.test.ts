import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DependencySnapshot,
  auditCapabilityBoundaries,
  collectDependencySnapshot,
  compareDependencySnapshot,
  importedReferences,
  serializeDependencySnapshot,
} from './audit-capability-boundaries';

const temporaryRoots: string[] = [];

function write(root: string, path: string, contents: string): void {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function makeFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'capability-boundaries-'));
  temporaryRoots.push(root);
  write(root, 'src/capabilities/alpha/public.ts', 'export const alpha = true;\n');
  write(root, 'src/capabilities/beta/public.ts', 'export const beta = true;\n');
  write(
    root,
    'src/capabilities/alpha/server/use.ts',
    `import { run } from '@/server/ai/runner';
import type { Runner } from '../../../server/ai/runner';
import { beta } from '@/capabilities/beta/public';
export const alphaUse = { run, beta } satisfies { run: typeof run; beta: boolean };
export type AlphaRunner = Runner;
`,
  );
  write(
    root,
    'src/capabilities/beta/server/use.ts',
    `import { alpha } from '@/capabilities/alpha/public';
export const betaUse = alpha;
`,
  );
  write(
    root,
    'src/server/ai/runner.ts',
    `export interface Runner { run(): void }
export const run = () => undefined;
`,
  );
  write(
    root,
    'src/server/boss/worker.ts',
    `import { alphaUse } from '@/capabilities/alpha/server/use';
import { beta } from '@/capabilities/beta/public';
export const work = { alphaUse, beta };
`,
  );
  return root;
}

function snapshot(root: string): DependencySnapshot {
  return collectDependencySnapshot(root).snapshot;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('capability boundary dependency parsing', () => {
  it('classifies type, mixed, side-effect, dynamic, and re-export dependencies', () => {
    const references = importedReferences(
      `import type { A } from './types';
import { type B } from './inline-types';
import { type C, run } from './mixed';
import './side-effect';
type Lazy = import('./type-query').Lazy;
export type { E } from './export-type';
export { type F, value } from './export-mixed';
const promise = import('./dynamic');
import type { Duplicate } from './duplicate';
import { value as duplicateValue } from './duplicate';
void promise;
void duplicateValue;
`,
      'fixture.ts',
    );

    expect(Object.fromEntries(references.map(({ source, kind }) => [source, kind]))).toEqual({
      './duplicate': 'value',
      './dynamic': 'value',
      './export-mixed': 'value',
      './export-type': 'type',
      './inline-types': 'type',
      './mixed': 'value',
      './side-effect': 'value',
      './type-query': 'type',
      './types': 'type',
    });
  });

  it('fails closed on a non-literal dynamic import', () => {
    expect(() => importedReferences("const target = './x'; import(target);", 'fixture.ts')).toThrow(
      'non-literal dynamic import',
    );
  });
});

describe('capability boundary dependency ratchet', () => {
  it('normalizes alias and relative imports into one semantic edge', () => {
    const root = makeFixture();
    const { snapshot: current, report } = collectDependencySnapshot(root);

    expect(current.debts.capabilityToServer).toEqual({
      total: 1,
      byOwnerPair: { 'alpha -> ai': 1 },
    });
    expect(current.debts.serverToCapabilityDeep).toEqual({
      total: 1,
      byOwnerPair: { 'boss -> alpha': 1 },
    });
    expect(report.serverToCapabilityPublic).toBe(1);
    expect(current.debts.crossCapabilityValue).toEqual({
      total: 2,
      byOwnerPair: { 'alpha -> beta': 1, 'beta -> alpha': 1 },
      nontrivialSccs: [['alpha', 'beta']],
    });
  });

  it('rejects a new edge in an existing capability-to-server owner pair', () => {
    const root = makeFixture();
    const baseline = snapshot(root);
    write(root, 'src/server/ai/other.ts', 'export const other = true;\n');
    write(
      root,
      'src/capabilities/alpha/server/second.ts',
      `import { other } from '@/server/ai/other';
export const second = other;
`,
    );

    expect(compareDependencySnapshot(snapshot(root), baseline)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'alpha -> ai',
          reason: expect.stringContaining('architecture regression: 2 > baseline 1'),
        }),
      ]),
    );
  });

  it('requires the baseline to tighten when debt decreases', () => {
    const root = makeFixture();
    const baseline = snapshot(root);
    write(
      root,
      'src/capabilities/alpha/server/use.ts',
      `import { beta } from '@/capabilities/beta/public';
export const alphaUse = beta;
`,
    );

    expect(compareDependencySnapshot(snapshot(root), baseline)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'alpha -> ai',
          reason: expect.stringContaining('tighten the baseline'),
        }),
      ]),
    );
  });

  it('rejects a new server-to-capability deep edge', () => {
    const root = makeFixture();
    const baseline = snapshot(root);
    write(root, 'src/capabilities/beta/public/internal.ts', 'export const internal = true;\n');
    write(
      root,
      'src/server/boss/nested.ts',
      `import { internal } from '@/capabilities/beta/public/internal';
export const nested = internal;
`,
    );

    expect(compareDependencySnapshot(snapshot(root), baseline)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'boss -> beta',
          reason: expect.stringContaining('server -> capability deep architecture regression'),
        }),
      ]),
    );
  });

  it('rejects a cross-bucket replacement even when the total is unchanged', () => {
    const root = makeFixture();
    const baseline = snapshot(root);
    write(
      root,
      'src/capabilities/alpha/server/use.ts',
      `import { work } from '@/server/boss/worker';
import { beta } from '@/capabilities/beta/public';
export const alphaUse = { work, beta };
`,
    );

    const violations = compareDependencySnapshot(snapshot(root), baseline);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'alpha -> ai' }),
        expect.objectContaining({ source: 'alpha -> boss' }),
      ]),
    );
  });

  it('detects a cross-capability value SCC growing through a new return edge', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/gamma/public.ts', 'export const gamma = true;\n');
    write(
      root,
      'src/capabilities/gamma/server/use.ts',
      `import { alpha } from '@/capabilities/alpha/public';
export const gammaUse = alpha;
`,
    );
    const baseline = snapshot(root);
    write(
      root,
      'src/capabilities/alpha/server/gamma.ts',
      `import { gamma } from '@/capabilities/gamma/public';
export const alphaGamma = gamma;
`,
    );

    expect(compareDependencySnapshot(snapshot(root), baseline)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'crossCapabilityValue.nontrivialSccs',
          reason: expect.stringContaining('SCC grew'),
        }),
      ]),
    );
  });

  it('rejects a new one-way cross-capability value edge without requiring a cycle', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/gamma/public.ts', 'export const gamma = true;\n');
    const baseline = snapshot(root);
    write(
      root,
      'src/capabilities/gamma/server/use.ts',
      `import { beta } from '@/capabilities/beta/public';
export const gammaUse = beta;
`,
    );

    const violations = compareDependencySnapshot(snapshot(root), baseline);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'gamma -> beta',
          reason: expect.stringContaining('cross-capability value architecture regression'),
        }),
      ]),
    );
    expect(violations.map((violation) => violation.source)).not.toContain(
      'crossCapabilityValue.nontrivialSccs',
    );
  });

  it('keeps the original public-entrypoint seam enforcement', () => {
    const root = makeFixture();
    write(
      root,
      'src/capabilities/alpha/server/use.ts',
      `import { betaUse } from '@/capabilities/beta/server/use';
export const alphaUse = betaUse;
`,
    );

    expect(auditCapabilityBoundaries(root).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '@/capabilities/beta/server/use',
          reason: expect.stringContaining('cross-capability imports must target'),
        }),
      ]),
    );
  });

  it('does not treat nested public, ui-public, or manifest modules as entrypoints', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/beta/public/internal.ts', 'export const internal = true;\n');
    write(root, 'src/capabilities/beta/ui-public/internal.ts', 'export const internalUi = true;\n');
    write(
      root,
      'src/capabilities/beta/manifest/internal.ts',
      'export const internalManifest = true;\n',
    );
    write(
      root,
      'src/capabilities/alpha/server/nested-public.ts',
      `import { internal } from '@/capabilities/beta/public/internal';
export const nestedPublic = internal;
`,
    );
    write(
      root,
      'src/capabilities/alpha/ui/nested-ui.ts',
      `import { internalUi } from '@/capabilities/beta/ui-public/internal';
export const nestedUi = internalUi;
`,
    );
    write(
      root,
      'src/capabilities/index.ts',
      `import { internalManifest } from '@/capabilities/beta/manifest/internal';
export const manifests = [internalManifest];
`,
    );

    expect(auditCapabilityBoundaries(root).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: '@/capabilities/beta/public/internal' }),
        expect.objectContaining({ source: '@/capabilities/beta/ui-public/internal' }),
        expect.objectContaining({ source: '@/capabilities/beta/manifest/internal' }),
      ]),
    );
  });

  it('serializes a canonical, stable snapshot', () => {
    const root = makeFixture();
    const first = snapshot(root);
    const second = snapshot(root);

    expect(serializeDependencySnapshot(first)).toBe(serializeDependencySnapshot(second));
    const pairs = Object.keys(first.debts.crossCapabilityValue.byOwnerPair);
    expect(pairs).toEqual([...pairs].sort());
  });
});
