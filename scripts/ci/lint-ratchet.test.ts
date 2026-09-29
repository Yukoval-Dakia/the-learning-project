import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DiagnosticSummary,
  type LintBaselineDocument,
  buildBaselineDocument,
  evaluateRatchet,
  ruleDeltas,
  summarizeDiagnostics,
} from './lint-ratchet.mjs';

function diagnostic(severity: string | undefined, category: string) {
  return { severity, category, location: { path: 'src/example.ts' }, message: 'example' };
}

function baseline(totals: {
  warnings: number;
  infos?: number;
  errors?: number;
}): LintBaselineDocument {
  return {
    schemaVersion: 1,
    channel: 'test fixture',
    infoPolicy: 'counted',
    totals: { errors: totals.errors ?? 0, warnings: totals.warnings, infos: totals.infos ?? 0 },
    byRule: {},
  };
}

describe('lint warning ratchet', () => {
  it.each([
    { name: 'clean source', source: 'export const answer = 42;\n', expected: 0, category: null },
    {
      name: 'formatting error',
      source: 'export const answer=42\n',
      expected: 1,
      category: 'format',
    },
    { name: 'parse error', source: 'export const = ;\n', expected: 1, category: 'parse' },
  ])(
    'runs the real lint gate for $name without a preceding lint command',
    ({ source, expected, category }) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'lint-gate-')));
      const dependencyPath = path.resolve('node_modules/vitest/package.json');
      const dependencyBefore = readFileSync(dependencyPath, 'utf8');
      try {
        mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
        copyFileSync(
          path.resolve('scripts/ci/lint-ratchet.mjs'),
          path.join(root, 'scripts/ci/lint-ratchet.mjs'),
        );
        symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
        writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({
            private: true,
            packageManager: JSON.parse(readFileSync('package.json', 'utf8')).packageManager,
          }),
        );
        writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n');
        writeFileSync(
          path.join(root, 'biome.json'),
          '{"files":{"includes":["sample.js"]},"json":{"formatter":{"enabled":false}}}\n',
        );
        writeFileSync(
          path.join(root, 'scripts/lint-baseline.json'),
          JSON.stringify(baseline({ warnings: 0 })),
        );
        writeFileSync(path.join(root, 'sample.js'), source);
        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/ci/lint-ratchet.mjs')],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(readFileSync(dependencyPath, 'utf8')).toBe(dependencyBefore);
        expect(result.status, result.stdout + result.stderr).toBe(expected);
        if (expected === 0) expect(result.stdout).toContain('[lint-ratchet] OK');
        else expect(result.stderr).toContain(category);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('summarizes diagnostics by severity and by rule', () => {
    const summary = summarizeDiagnostics([
      diagnostic('warning', 'lint/correctness/noUnusedImports'),
      diagnostic('warning', 'lint/correctness/noUnusedImports'),
      diagnostic('warning', 'lint/style/noDescendingSpecificity'),
      diagnostic('info', 'lint/complexity/noUselessStringRaw'),
      diagnostic('error', 'lint/style/noRestrictedImports'),
      diagnostic('weird-future-severity', 'lint/x/unknown'),
      diagnostic(undefined, 'lint/x/missing-severity'),
    ]);
    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(3);
    expect(summary.infos).toBe(1);
    expect(summary.byRule).toEqual({
      'lint/correctness/noUnusedImports': { warning: 2 },
      'lint/style/noDescendingSpecificity': { warning: 1 },
      'lint/complexity/noUselessStringRaw': { info: 1 },
      'lint/style/noRestrictedImports': { error: 1 },
    });
  });

  it('passes and is not stale when current equals baseline', () => {
    const current: DiagnosticSummary = { errors: 0, warnings: 337, infos: 1, byRule: {} };
    const verdict = evaluateRatchet(current, baseline({ warnings: 337, infos: 1 }));
    expect(verdict).toEqual({ ok: true, staleBy: {}, regressions: [] });
  });

  it('fails when warnings exceed the baseline', () => {
    const current: DiagnosticSummary = { errors: 0, warnings: 338, infos: 1, byRule: {} };
    const verdict = evaluateRatchet(current, baseline({ warnings: 337, infos: 1 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions).toEqual([{ severity: 'warning', baseline: 337, current: 338 }]);
  });

  it('fails when infos exceed the baseline even with unchanged warnings', () => {
    const current: DiagnosticSummary = { errors: 0, warnings: 337, infos: 2, byRule: {} };
    const verdict = evaluateRatchet(current, baseline({ warnings: 337, infos: 1 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions).toEqual([{ severity: 'info', baseline: 1, current: 2 }]);
  });

  it('fails on error diagnostics regardless of warning totals', () => {
    const current: DiagnosticSummary = { errors: 1, warnings: 0, infos: 0, byRule: {} };
    const verdict = evaluateRatchet(current, baseline({ warnings: 337 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.regressions[0].severity).toBe('error');
  });

  it('passes with a stale notice when the tree improved below the baseline', () => {
    const current: DiagnosticSummary = { errors: 0, warnings: 300, infos: 0, byRule: {} };
    const verdict = evaluateRatchet(current, baseline({ warnings: 337, infos: 1 }));
    expect(verdict.ok).toBe(true);
    expect(verdict.staleBy).toEqual({ warnings: 37, infos: 1 });
  });

  it('attributes growth and shrinkage per rule, growth sorted first', () => {
    const current = summarizeDiagnostics([
      ...Array.from({ length: 5 }, () => diagnostic('warning', 'lint/a/growing')),
      ...Array.from({ length: 2 }, () => diagnostic('warning', 'lint/b/shrinking')),
      diagnostic('info', 'lint/c/new-info'),
    ]);
    const base: LintBaselineDocument = {
      ...baseline({ warnings: 337, infos: 1 }),
      byRule: {
        'lint/a/growing': { warning: 3 },
        'lint/b/shrinking': { warning: 4 },
      },
    };
    expect(ruleDeltas(current, base)).toEqual([
      { category: 'lint/a/growing', severity: 'warning', baseline: 3, current: 5, delta: 2 },
      { category: 'lint/c/new-info', severity: 'info', baseline: 0, current: 1, delta: 1 },
      { category: 'lint/b/shrinking', severity: 'warning', baseline: 4, current: 2, delta: -2 },
    ]);
  });

  it('builds a deterministic, human-reviewable baseline document', () => {
    const summary = summarizeDiagnostics([
      diagnostic('info', 'lint/z/last-rule'),
      diagnostic('warning', 'lint/a/first-rule'),
      diagnostic('warning', 'lint/a/first-rule'),
    ]);
    const document = buildBaselineDocument(summary);
    expect(document.schemaVersion).toBe(1);
    expect(document.totals).toEqual({ errors: 0, warnings: 2, infos: 1 });
    expect(Object.keys(document.byRule)).toEqual(['lint/a/first-rule', 'lint/z/last-rule']);
    expect(document.byRule['lint/a/first-rule']).toEqual({ warning: 2 });
    expect(document.byRule['lint/z/last-rule']).toEqual({ info: 1 });
    // Regenerating from the same summary must be byte-stable.
    expect(JSON.stringify(buildBaselineDocument(summary))).toBe(JSON.stringify(document));
  });
});
