import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHADOW_SENTINEL_TESTS, buildShadowReport, mergePredictedFiles } from './unit-shadow.mjs';

const root = '/repo';

describe('unit affected-test shadow', () => {
  it('normalizes Vitest selections and unions source-scanning sentinels', () => {
    expect(
      mergePredictedFiles(
        [{ file: '/repo/src/core/theta.test.ts' }, { file: '/repo/src/core/theta.test.ts' }],
        root,
      ),
    ).toEqual(
      [...SHADOW_SENTINEL_TESTS, 'src/core/theta.test.ts'].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('reports a full-suite failure outside the predicted affected set as a miss', () => {
    const report = buildShadowReport({
      root,
      selection: {
        schema_version: 1,
        requested_mode: 'affected',
        effective_mode: 'affected',
        base: 'abc',
        changed_files: ['src/feature.ts'],
        predicted_files: ['src/feature.test.ts'],
      },
      fullResults: {
        success: false,
        testResults: [
          { name: path.join(root, 'src/feature.test.ts'), status: 'passed' },
          { name: path.join(root, 'src/regression.test.ts'), status: 'failed' },
        ],
      },
    });

    expect(report.missed_failures).toEqual(['src/regression.test.ts']);
    expect(report.status).toBe('warning');
  });

  it('reports a directly changed unit test omitted by the selector', () => {
    const report = buildShadowReport({
      root,
      selection: {
        schema_version: 1,
        requested_mode: 'affected',
        effective_mode: 'affected',
        base: 'abc',
        changed_files: ['src/direct.unit.test.ts'],
        predicted_files: [],
      },
      fullResults: {
        success: true,
        testResults: [{ name: path.join(root, 'src/direct.unit.test.ts'), status: 'passed' }],
      },
    });

    expect(report.changed_tests_missed).toEqual(['src/direct.unit.test.ts']);
    expect(report.status).toBe('warning');
  });

  it('treats a selector fallback as full without inventing misses', () => {
    const report = buildShadowReport({
      root,
      selection: {
        schema_version: 1,
        requested_mode: 'affected',
        effective_mode: 'full',
        fallback_reason: 'vitest-list-failed',
        base: 'abc',
        changed_files: ['src/feature.ts'],
        predicted_files: null,
      },
      fullResults: {
        success: true,
        testResults: [
          { name: path.join(root, 'src/feature.test.ts'), status: 'passed' },
          { name: path.join(root, 'src/other.test.ts'), status: 'passed' },
        ],
      },
    });

    expect(report.selected_files).toBe(2);
    expect(report.missed_failures).toEqual([]);
    expect(report.status).toBe('fallback');
  });

  it('keeps selector-only paths visible without treating them as failures', () => {
    const report = buildShadowReport({
      root,
      selection: {
        schema_version: 1,
        requested_mode: 'affected',
        effective_mode: 'affected',
        base: 'abc',
        changed_files: ['src/feature.ts'],
        predicted_files: ['src/deleted.test.ts', 'src/feature.test.ts'],
      },
      fullResults: {
        success: true,
        testResults: [{ name: path.join(root, 'src/feature.test.ts'), status: 'passed' }],
      },
    });

    expect(report.predicted_not_in_full).toEqual(['src/deleted.test.ts']);
    expect(report.status).toBe('ok');
  });
});
