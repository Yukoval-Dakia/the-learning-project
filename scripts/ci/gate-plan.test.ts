import { describe, expect, it } from 'vitest';
import { classifyChangedFiles } from './gate-plan.mjs';

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
});
