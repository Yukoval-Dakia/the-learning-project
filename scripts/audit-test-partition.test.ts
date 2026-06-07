import { describe, expect, it } from 'vitest';
import { classify, isTestFileName, walkTests } from './audit-test-partition';

// YUK-279 — regression guard for the `.test.tsx` partition blind spot.
//
// Before the fix the walker filtered files with `endsWith('.test.ts')`, which is
// false for any `.test.tsx` (it ends in `x`). Component tests were therefore never
// collected by the auditor at all — they showed up as neither unit, db, nor
// unmatched — so a `.test.tsx` that matched no vitest `include` glob silently
// never ran while the audit stayed green. These tests pin both halves of the fix:
// the file-name predicate and the partition classifier both treat `.tsx` exactly
// like `.ts`.

describe('isTestFileName — collects .test.ts AND .test.tsx', () => {
  it('accepts .test.ts', () => {
    expect(isTestFileName('foo.test.ts')).toBe(true);
  });

  it('accepts .test.tsx (the blind spot — a .test.tsx ends in `x`)', () => {
    expect(isTestFileName('Component.test.tsx')).toBe(true);
  });

  it('rejects non-test sources', () => {
    expect(isTestFileName('Component.tsx')).toBe(false);
    expect(isTestFileName('foo.ts')).toBe(false);
    expect(isTestFileName('foo.test.js')).toBe(false);
  });
});

describe('classify — .tsx files land in a real partition, never unmatched', () => {
  it('routes a unit-allowlisted src/ui .test.tsx to the unit partition', () => {
    // src/ui/**/*.test.tsx is on fastTestInclude (the unit allowlist).
    expect(classify('src/ui/components/VisionTab.test.tsx')).toBe('unit');
  });

  it('routes the explicitly-allowlisted inbox .test.tsx to the unit partition', () => {
    expect(classify('app/(app)/inbox/inbox.test.tsx')).toBe('unit');
  });

  it('falls a NON-allowlisted app/ .test.tsx through to the db partition (not unmatched)', () => {
    // This is the previously-broken path: a component test outside the unit
    // allowlist must be swept up by allTestInclude's `app/**/*.test.tsx` glob and
    // land in db — exactly like a `.test.ts` would. Before the vitest.shared.ts
    // fix it matched no glob and was collected by NEITHER config.
    const partition = classify('app/(app)/some-feature/widget.test.tsx');
    expect(partition).toBe('db');
    expect(partition).not.toBe('unmatched');
  });
});

describe('walkTests — actually discovers the repo .test.tsx files', () => {
  it('includes known component tests in its walk', () => {
    const files = walkTests(process.cwd());
    const tsx = files.filter((f) => f.endsWith('.test.tsx'));
    // The repo ships component tests; the walker must see them. (Before the fix
    // this set was empty because endsWith('.test.ts') skipped every `.tsx`.)
    expect(tsx.length).toBeGreaterThan(0);
    expect(files).toContain('src/ui/components/VisionTab.test.tsx');
  });
});
