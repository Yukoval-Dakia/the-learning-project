import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { physicsProfile } from '@/subjects/physics/profile';
import { serializeProfileToTs } from '@/subjects/serialize';
import { wenyanProfile } from '@/subjects/wenyan/profile';
import { afterAll, describe, expect, it } from 'vitest';
import { compileProfile, runCli } from './compile-profile';

// Step 4 acceptance — Critic path is NOT exercised here (no --critic flag), so no
// DB/runner is touched; these are pure no-DB unit assertions.

const tmpDir = mkdtempSync(join(tmpdir(), 'compile-profile-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeDraft(name: string, draft: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(draft));
  return path;
}

describe('compileProfile (pure core)', () => {
  it('a valid draft → valid:true, empty errors, diff vs current', () => {
    // Same content as the live wenyan profile but with one cause label edited →
    // diff should report `causeCategories` as the single changed top-level key (G1).
    const draft = {
      ...wenyanProfile,
      causeCategories: wenyanProfile.causeCategories.map((cause, i) =>
        i === 0 ? { ...cause, label: `${cause.label} (edited)` } : cause,
      ),
    };
    const { report } = compileProfile(draft);

    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.diff.changed).toEqual(['causeCategories']);
    expect(report.diff.added).toEqual([]);
    expect(report.diff.removed).toEqual([]);
    expect(report.suggested_bump).toContain('high-impact');
  });

  it('an unchanged draft → valid:true with an empty diff and no bump suggestion', () => {
    const { report } = compileProfile(physicsProfile);
    expect(report.valid).toBe(true);
    expect(report.diff).toEqual({ changed: [], added: [], removed: [] });
    expect(report.suggested_bump).toBeUndefined();
  });

  it('an invalid draft (unknown judge capability) → valid:false with the registry error', () => {
    const draft = {
      ...physicsProfile,
      judgeCapabilities: [...physicsProfile.judgeCapabilities, 'ghost_judge'],
    };
    const { report, profile } = compileProfile(draft);

    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.includes('ghost_judge'))).toBe(true);
    expect(profile).toBeUndefined();
  });

  it('a draft missing version parses but fails validate (Q7 — author must fill version)', () => {
    const { version: _version, ...draftNoVersion } = physicsProfile;
    const { report } = compileProfile(draftNoVersion);
    // SubjectProfileDraftSchema accepts the missing version (it is optional in
    // drafts), but validateProfile (full SubjectProfile) flags it.
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true);
  });
});

describe('runCli --write (RL7 gate)', () => {
  it('refuses to write an invalid draft (no file mutation) — proves RL7', async () => {
    const badDraft = {
      ...physicsProfile,
      judgeCapabilities: ['ghost_judge'],
    };
    const path = writeDraft('bad.json', badDraft);
    // Snapshot the real physics profile.ts before the run; --write must NOT touch it.
    const profileTsPath = join(process.cwd(), 'src', 'subjects', 'physics', 'profile.ts');
    const before = readFileSync(profileTsPath, 'utf-8');

    const exitCode = await runCli([path, '--write', '--json']);

    expect(exitCode).toBe(1);
    expect(readFileSync(profileTsPath, 'utf-8')).toBe(before); // unchanged
  });

  it('writes the serialized profile.ts for a valid draft (gate ALLOWS the write)', async () => {
    // Exercise the real --write fs path end-to-end against an existing subject dir
    // (physics), then restore the original file so the repo is untouched. The
    // written bytes must equal the serializer output (round-trip equality itself is
    // covered exhaustively by serialize.test.ts).
    const profileTsPath = join(process.cwd(), 'src', 'subjects', 'physics', 'profile.ts');
    const original = readFileSync(profileTsPath, 'utf-8');
    const draft = { ...physicsProfile, displayName: '物理 (compile smoke)' };
    const path = writeDraft('valid.json', draft);
    try {
      const exitCode = await runCli([path, '--write']);
      expect(exitCode).toBe(0);
      expect(readFileSync(profileTsPath, 'utf-8')).toBe(serializeProfileToTs(draft));
    } finally {
      writeFileSync(profileTsPath, original);
    }
  });
});
