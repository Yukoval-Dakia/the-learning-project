// YUK-288 — resolveKnownSubjectId unit test (no DB).
//
// The derived `?subject=` axis (resolveSubjectKnowledgeIds) must distinguish a
// GENUINE subject hit from the default-profile fallback. resolveSubjectProfile
// over-matches: a null/unknown domain returns the DEFAULT profile (general), so
// untagged or unknown-domain nodes would be swept into a subject tab.
// resolveKnownSubjectId returns null on those, fixing the over-match while
// staying alias-aware.
//
// YUK-249 — the subject was renamed wenyan → yuwen. `yuwen` is now the canonical
// id; the legacy `wenyan` id is DEMOTED to an alias, so historical domain='wenyan'
// data / old backups / event payloads still normalise to yuwen.

import { describe, expect, it } from 'vitest';
import { KNOWN_SUBJECT_IDS, resolveKnownSubjectId, resolveSubjectProfile } from './profile';

describe('resolveKnownSubjectId', () => {
  it('resolves a bare profile id (registered as a self alias)', () => {
    expect(resolveKnownSubjectId('yuwen')).toBe('yuwen');
    expect(resolveKnownSubjectId('math')).toBe('math');
    expect(resolveKnownSubjectId('physics')).toBe('physics');
  });

  it('resolves the legacy wenyan id to the canonical yuwen (YUK-249 rename alias)', () => {
    expect(resolveKnownSubjectId('wenyan')).toBe('yuwen');
    expect(resolveSubjectProfile('wenyan').id).toBe('yuwen');
  });

  it('resolves known aliases to their canonical subject id', () => {
    expect(resolveKnownSubjectId('classical_chinese')).toBe('yuwen');
    expect(resolveKnownSubjectId('chinese_classics')).toBe('yuwen');
    expect(resolveKnownSubjectId('mathematics')).toBe('math');
    expect(resolveKnownSubjectId('physical')).toBe('physics');
  });

  it('normalises case / whitespace before lookup', () => {
    expect(resolveKnownSubjectId('  WENYAN  ')).toBe('yuwen');
    expect(resolveKnownSubjectId('Mathematics')).toBe('math');
  });

  it('KNOWN_SUBJECT_IDS lists the canonical yuwen, not the legacy wenyan', () => {
    expect(KNOWN_SUBJECT_IDS).toContain('yuwen');
    expect(KNOWN_SUBJECT_IDS).not.toContain('wenyan');
  });

  it('returns null for a null/undefined/empty domain (NO default fallback)', () => {
    // The over-match the fix targets: resolveSubjectProfile(null) returns the
    // DEFAULT profile (general); resolveKnownSubjectId returns null.
    expect(resolveKnownSubjectId(null)).toBeNull();
    expect(resolveKnownSubjectId(undefined)).toBeNull();
    expect(resolveKnownSubjectId('')).toBeNull();
    expect(resolveKnownSubjectId('   ')).toBeNull();
    // Contrast: the resolver folds null → the neutral default subject (general).
    expect(resolveSubjectProfile(null).id).toBe('general');
  });

  it('returns null for an unrecognised non-null domain (NO default fallback)', () => {
    expect(resolveKnownSubjectId('chemistry')).toBeNull();
    expect(resolveKnownSubjectId('totally_unknown_domain')).toBeNull();
    // Contrast: the resolver folds an unknown string → the neutral default.
    expect(resolveSubjectProfile('totally_unknown_domain').id).toBe('general');
  });
});
