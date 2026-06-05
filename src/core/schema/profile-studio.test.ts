import { physicsProfile } from '@/subjects/physics/profile';
import { wenyanProfile } from '@/subjects/wenyan/profile';
import { describe, expect, it } from 'vitest';
import {
  type ProfileImpactReport,
  ProfileImpactReportSchema,
  SubjectProfileDraftSchema,
} from './profile-studio';

describe('SubjectProfileDraftSchema', () => {
  it('parses a complete valid draft (a live profile is a valid draft)', () => {
    const parsed = SubjectProfileDraftSchema.safeParse(wenyanProfile);
    expect(parsed.success).toBe(true);
  });

  it('parses a draft that omits version (Q7 — version is optional in drafts)', () => {
    const { version: _version, ...draftWithoutVersion } = wenyanProfile;
    const parsed = SubjectProfileDraftSchema.safeParse(draftWithoutVersion);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBeUndefined();
    }
  });

  it('still rejects a draft missing a non-version required field (G2 — only version relaxed)', () => {
    const { displayName: _displayName, ...draftMissingDisplayName } = wenyanProfile;
    const parsed = SubjectProfileDraftSchema.safeParse(draftMissingDisplayName);
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty version string when present (G2 — version still .min(1) when supplied)', () => {
    const parsed = SubjectProfileDraftSchema.safeParse({ ...physicsProfile, version: '' });
    expect(parsed.success).toBe(false);
  });
});

describe('ProfileImpactReportSchema', () => {
  const sampleReport: ProfileImpactReport = {
    subject_id: 'wenyan',
    valid: true,
    errors: [],
    warnings: [],
    diff: { changed: ['causeCategories'], added: [], removed: [] },
    suggested_bump: 'minor',
  };

  it('parses a well-formed impact report', () => {
    const parsed = ProfileImpactReportSchema.safeParse(sampleReport);
    expect(parsed.success).toBe(true);
  });

  it('parses a report without the optional suggested_bump', () => {
    const { suggested_bump: _suggested_bump, ...withoutBump } = sampleReport;
    const parsed = ProfileImpactReportSchema.safeParse(withoutBump);
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed report (valid is not a boolean)', () => {
    const parsed = ProfileImpactReportSchema.safeParse({ ...sampleReport, valid: 'yes' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a report whose diff entries are not string arrays (G1 — top-level key names)', () => {
    const parsed = ProfileImpactReportSchema.safeParse({
      ...sampleReport,
      diff: { changed: [{ causeCategories: 'x' }], added: [], removed: [] },
    });
    expect(parsed.success).toBe(false);
  });
});
