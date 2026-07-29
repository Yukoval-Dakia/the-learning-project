import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyChangedFiles, parseNulDelimitedPaths, readGitChangedFiles } from './gate-plan.mjs';

describe('CI gate lane planner', () => {
  it('skips every heavyweight lane for docs-only changes', () => {
    expect(
      classifyChangedFiles(['PLAN.md', 'docs/runbooks/ci.md', '.remember/now.md']),
    ).toMatchObject({
      code_changed: false,
      unit_selection: 'skip',
      lanes: {
        static: false,
        unit: false,
        db: false,
        migration: false,
        build: false,
        usability: false,
      },
    });
  });

  it('does not treat runtime markdown assets as docs-only', () => {
    expect(classifyChangedFiles(['src/subjects/math/skills/note-math/SKILL.md'])).toMatchObject({
      code_changed: true,
      unit_selection: 'affected',
      lanes: {
        static: true,
        unit: true,
        db: true,
        migration: false,
        build: true,
        usability: true,
      },
    });
  });

  it('runs only the static lane for agent tooling and configuration', () => {
    expect(classifyChangedFiles(['.claude/hooks/git-guard.mjs'])).toMatchObject({
      code_changed: true,
      unit_selection: 'skip',
      reasons: ['agent-tooling'],
      lanes: {
        static: true,
        unit: false,
        db: false,
        migration: false,
        build: false,
        usability: false,
      },
    });
  });

  it('runs only static and unit for a conventional unit-test-only change', () => {
    expect(
      classifyChangedFiles(['src/capabilities/practice/ui/PfPaper.unit.test.tsx']),
    ).toMatchObject({
      code_changed: true,
      unit_selection: 'affected',
      lanes: {
        static: true,
        unit: true,
        db: false,
        migration: false,
        build: false,
        usability: false,
      },
    });
  });

  it('runs only static and DB for a DB-test-only change', () => {
    expect(classifyChangedFiles(['src/capabilities/practice/api/submit.db.test.ts'])).toMatchObject(
      {
        unit_selection: 'skip',
        lanes: {
          static: true,
          unit: false,
          db: true,
          migration: false,
          build: false,
          usability: false,
        },
      },
    );
  });

  it('runs the UI surface lanes without starting Postgres or migration smoke', () => {
    expect(classifyChangedFiles(['src/capabilities/practice/ui/PfPaper.tsx'])).toMatchObject({
      unit_selection: 'affected',
      lanes: {
        static: true,
        unit: true,
        db: false,
        migration: false,
        build: true,
        usability: true,
      },
    });
  });

  it('runs server validation lanes but not migration smoke for an API implementation', () => {
    expect(classifyChangedFiles(['src/capabilities/practice/api/submit.ts'])).toMatchObject({
      unit_selection: 'affected',
      lanes: {
        static: true,
        unit: true,
        db: true,
        migration: false,
        build: true,
        usability: false,
      },
    });
  });

  it.each([
    'src/db/schema.ts',
    'drizzle/0099_example.sql',
    'src/kernel/capability.ts',
    'src/capabilities/practice/manifest.ts',
    'pnpm-lock.yaml',
    'vitest.shared.ts',
    '.github/workflows/ci-gate.yml',
  ])('fails closed to every lane for global trigger %s', (file) => {
    const plan = classifyChangedFiles([file]);
    expect(plan.unit_selection).toBe('full');
    expect(Object.values(plan.lanes).every(Boolean)).toBe(true);
  });

  it('fails closed for an unclassified code path', () => {
    const plan = classifyChangedFiles(['postman/api-endpoints.json']);
    expect(plan.unit_selection).toBe('full');
    expect(Object.values(plan.lanes).every(Boolean)).toBe(true);
    expect(plan.reasons).toContain('unclassified:postman/api-endpoints.json');
  });

  it('keeps the cumulative PR plan non-docs when a docs closeout follows code', () => {
    const plan = classifyChangedFiles(['PLAN.md', 'web/src/router.tsx']);
    expect(plan.code_changed).toBe(true);
    expect(plan.lanes.build).toBe(true);
    expect(plan.lanes.usability).toBe(true);
  });

  it('fails closed when the caller cannot establish a trustworthy diff', () => {
    const plan = classifyChangedFiles([], { forceFullReason: 'base-unreachable' });
    expect(plan.unit_selection).toBe('full');
    expect(Object.values(plan.lanes).every(Boolean)).toBe(true);
    expect(plan.reasons).toContain('base-unreachable');
  });

  it('decodes raw NUL-delimited non-ASCII and newline paths', () => {
    expect(
      parseNulDelimitedPaths(Buffer.from('docs/成效趋势面.html\0odd\nname.ts\0', 'utf8')),
    ).toEqual(['docs/成效趋势面.html', 'odd\nname.ts']);
  });

  it('classifies both sides of a runtime-to-docs rename', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'gate-plan-rename-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'CI Gate Test'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'ci-gate@example.invalid'], { cwd: repo });
      mkdirSync(path.join(repo, 'src'));
      writeFileSync(path.join(repo, 'src', 'runtime.ts'), 'export const live = true;\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim();

      mkdirSync(path.join(repo, 'docs'));
      execFileSync('git', ['mv', 'src/runtime.ts', 'docs/runtime.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'rename'], { cwd: repo });

      const changed = readGitChangedFiles(base, 'HEAD', repo);
      expect(changed).toEqual(['docs/runtime.ts', 'src/runtime.ts']);
      const plan = classifyChangedFiles(changed);
      expect(plan.code_changed).toBe(true);
      expect(Object.values(plan.lanes).every(Boolean)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
