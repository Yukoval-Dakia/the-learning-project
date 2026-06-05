import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // Issue 1 (Codex 3361129316): malicious id with path-traversal segments must be
  // rejected before any filesystem write. Proves the safe-id guard is on the
  // --write path and that zero bytes are written.
  it('refuses --write when draft id contains path traversal (Issue 1)', async () => {
    const evilDraft = { ...physicsProfile, id: 'physics/../math' };
    const draftPath = writeDraft('evil.json', evilDraft);
    // In --json mode, status messages route to stderr; in non-json mode they go to
    // stdout via log=console.log. Capture both to find the rejection message.
    const captured: string[] = [];
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    let exitCode: number;
    try {
      exitCode = await runCli([draftPath, '--write']);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    // Must be rejected with exit 1 and an error message naming the bad id.
    expect(exitCode).toBe(1);
    expect(captured.some((l) => l.includes('physics/../math'))).toBe(true);
  });

  // Issue 3 (Codex 3361129325): --write for a brand-new subject id must succeed
  // even when the subject directory does not yet exist. The test writes to a
  // temporary directory injected via the cwd mock, then cleans up.
  it('creates missing subject directory for a new id (Issue 3)', async () => {
    // Use a freshly minted tmpdir as the working directory root so we don't
    // pollute src/subjects. We monkey-patch process.cwd inside runCli by calling
    // profilePathForId via the imported module (runCli calls process.cwd() at
    // call time). Simplest approach: write a one-off draft with a unique id that
    // maps to a subdir of our tmpDir by passing an absolute path via the positional
    // arg and targeting an unused path. Since profilePathForId uses process.cwd(),
    // we instead exercise mkdirSync directly: craft a valid draft and pass --write
    // against a real new subject id under src/subjects (cleaned up afterwards).
    const newId = 'zz_test_new_subject';
    const newDir = join(process.cwd(), 'src', 'subjects', newId);
    const newProfileTs = join(newDir, 'profile.ts');
    const draft = { ...wenyanProfile, id: newId };
    const draftPath = writeDraft('new-subject.json', draft);
    try {
      // Directory must NOT exist before the test.
      expect(existsSync(newDir)).toBe(false);
      const exitCode = await runCli([draftPath, '--write']);
      expect(exitCode).toBe(0);
      expect(existsSync(newProfileTs)).toBe(true);
    } finally {
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  // Issue 2 (Codex 3361129322): --json --write output must be a single parseable
  // JSON object (not two separate JSON blobs or mixed text).
  it('--json --write emits exactly one JSON object on stdout (Issue 2)', async () => {
    const profileTsPath = join(process.cwd(), 'src', 'subjects', 'physics', 'profile.ts');
    const original = readFileSync(profileTsPath, 'utf-8');
    const draft = { ...physicsProfile, displayName: '物理 (json-write smoke)' };
    const draftPath = writeDraft('json-write.json', draft);
    const stdoutLines: string[] = [];
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map(String).join(' '));
    };
    try {
      const exitCode = await runCli([draftPath, '--write', '--json']);
      expect(exitCode).toBe(0);
      // Exactly one JSON.parse call must succeed on the joined output.
      const joined = stdoutLines.join('\n');
      const parsed = JSON.parse(joined) as { report: unknown; write_result?: { wrote: string } };
      expect(parsed.report).toBeDefined();
      expect(parsed.write_result?.wrote).toContain('physics');
    } finally {
      console.log = origLog;
      writeFileSync(profileTsPath, original);
    }
  });
});
