// YUK-288 — resolveKnownSubjectId unit test (no DB).
//
// The derived `?subject=` axis (resolveSubjectKnowledgeIds) must distinguish a
// GENUINE subject hit from the default-profile fallback. resolveSubjectProfile
// over-matches: a null/unknown domain returns the DEFAULT profile (wenyan), so
// untagged or unknown-domain nodes were swept into `?subject=wenyan`.
// resolveKnownSubjectId returns null on those, fixing the over-match while
// staying alias-aware.

import { describe, expect, it } from 'vitest';
import { resolveKnownSubjectId, resolveSubjectProfile } from './profile';

describe('resolveKnownSubjectId', () => {
  it('resolves a bare profile id (registered as a self alias)', () => {
    expect(resolveKnownSubjectId('wenyan')).toBe('wenyan');
    expect(resolveKnownSubjectId('math')).toBe('math');
    expect(resolveKnownSubjectId('physics')).toBe('physics');
  });

  it('resolves known aliases to their canonical subject id', () => {
    expect(resolveKnownSubjectId('classical_chinese')).toBe('wenyan');
    expect(resolveKnownSubjectId('mathematics')).toBe('math');
    expect(resolveKnownSubjectId('physical')).toBe('physics');
  });

  it('normalises case / whitespace before lookup', () => {
    expect(resolveKnownSubjectId('  WENYAN  ')).toBe('wenyan');
    expect(resolveKnownSubjectId('Mathematics')).toBe('math');
  });

  it('returns null for a null/undefined/empty domain (NO default fallback)', () => {
    // The over-match the fix targets: resolveSubjectProfile(null) returns the
    // DEFAULT profile (wenyan); resolveKnownSubjectId returns null.
    expect(resolveKnownSubjectId(null)).toBeNull();
    expect(resolveKnownSubjectId(undefined)).toBeNull();
    expect(resolveKnownSubjectId('')).toBeNull();
    expect(resolveKnownSubjectId('   ')).toBeNull();
    // Contrast: the old resolver folds null → the default subject.
    expect(resolveSubjectProfile(null).id).toBe('wenyan');
  });

  it('returns null for an unrecognised non-null domain (NO default fallback)', () => {
    expect(resolveKnownSubjectId('chemistry')).toBeNull();
    expect(resolveKnownSubjectId('totally_unknown_domain')).toBeNull();
    // Contrast: the old resolver folds an unknown string → the default subject.
    expect(resolveSubjectProfile('totally_unknown_domain').id).toBe('wenyan');
  });
});
