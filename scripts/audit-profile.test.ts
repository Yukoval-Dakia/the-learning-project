import { getDefaultRegistry } from '@/core/capability/judges';
import { type SubjectProfile, subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { auditProfiles, formatProfileAuditReport } from './audit-profile';

function makeAuditProfile(overrides: Partial<SubjectProfile> = {}): SubjectProfile {
  const base = subjectProfiles.math;
  return {
    ...base,
    id: 'audit_test',
    displayName: 'Audit Test',
    judgePolicy: {
      preferredRoutes: [...base.judgePolicy.preferredRoutes],
      notes: [...base.judgePolicy.notes],
    },
    noteTemplate: { ...base.noteTemplate },
    grounding: {
      ...base.grounding,
      allowedSources: [...base.grounding.allowedSources],
    },
    promptFragments: { ...base.promptFragments },
    causeCategories: base.causeCategories.map((category) => ({ ...category })),
    renderConfig: { ...base.renderConfig },
    schedulingHints: { ...base.schedulingHints },
    judgeCapabilities: [...base.judgeCapabilities],
    ...overrides,
  };
}

describe('auditProfiles', () => {
  it('passes for all built-in profiles', () => {
    const result = auditProfiles();

    expect(result.valid).toBe(true);
    expect(result.invalid).toBe(0);
    expect(result.entries.map((entry) => entry.id).sort()).toEqual(['math', 'physics', 'wenyan']);
  });

  it('fails when a profile declares an unknown judge capability', () => {
    const profile = makeAuditProfile({
      judgeCapabilities: [...subjectProfiles.math.judgeCapabilities, 'ghost_judge'],
    });
    const result = auditProfiles([profile], getDefaultRegistry());

    expect(result.valid).toBe(false);
    expect(result.entries[0]?.errors.some((error) => error.includes('ghost_judge'))).toBe(true);
  });

  it('fails when a profile repeats a cause category id', () => {
    const duplicate = {
      ...subjectProfiles.math.causeCategories[0],
      label: 'Duplicate cause',
    };
    const result = auditProfiles(
      [
        makeAuditProfile({
          causeCategories: [subjectProfiles.math.causeCategories[0], duplicate],
        }),
      ],
      getDefaultRegistry(),
    );

    expect(result.valid).toBe(false);
    expect(result.entries[0]?.errors.some((error) => error.includes('duplicate id'))).toBe(true);
  });

  it('fails when promptFragments is missing', () => {
    const { promptFragments: _promptFragments, ...profile } = makeAuditProfile();
    const result = auditProfiles([profile as SubjectProfile], getDefaultRegistry());

    expect(result.valid).toBe(false);
    expect(
      result.entries[0]?.errors.some((error) => error.includes('SubjectProfile.promptFragments')),
    ).toBe(true);
  });

  it('accumulates all invalid profiles in one audit result', () => {
    const missingFragments = makeAuditProfile({ id: 'missing_fragments' });
    const { promptFragments: _promptFragments, ...missingFragmentsBody } = missingFragments;
    const result = auditProfiles(
      [
        makeAuditProfile({
          id: 'bad_capability',
          judgeCapabilities: ['ghost_judge'],
        }),
        makeAuditProfile({
          id: 'bad_duplicate_cause',
          causeCategories: [
            subjectProfiles.math.causeCategories[0],
            {
              ...subjectProfiles.math.causeCategories[0],
              label: 'Duplicate cause',
            },
          ],
        }),
        missingFragmentsBody as SubjectProfile,
      ],
      getDefaultRegistry(),
    );

    expect(result.valid).toBe(false);
    expect(result.invalid).toBe(3);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      'bad_capability',
      'bad_duplicate_cause',
      'missing_fragments',
    ]);
  });

  it('formats invalid profiles with readable details', () => {
    const result = auditProfiles(
      [
        makeAuditProfile({
          judgeCapabilities: ['ghost_judge'],
        }),
      ],
      getDefaultRegistry(),
    );
    const report = formatProfileAuditReport(result);

    expect(report).toContain('[audit_test] invalid');
    expect(report).toContain('ghost_judge');
    expect(report).toContain('ERROR: one or more SubjectProfile declarations are invalid');
  });
});
