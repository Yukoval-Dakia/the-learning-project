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

// Shared tmpdir for draft JSON files.
const tmpDir = mkdtempSync(join(tmpdir(), 'compile-profile-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeDraft(name: string, draft: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(draft));
  return path;
}

// Issues 2+3 (Codex 3361262852, CR 3361255163): all --write tests use an
// outputRoot sandbox so the real src/subjects tree is NEVER touched, eliminating
// the concurrent-test pollution window and the fixed-id/rmSync-blast-radius risk.
//
// Pattern: each --write test creates its own mkdtemp sandbox that mirrors the
// expected src/subjects/<id>/ layout under outputRoot. The sandbox is cleaned up
// in afterAll (tmpDir already covers it since sandboxes are created under tmpDir).
function makeSandbox(subDir = 'sandbox'): string {
  const root = mkdtempSync(join(tmpDir, subDir));
  return root;
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
    const sandbox = makeSandbox('rl7-refuse');
    const badDraft = {
      ...physicsProfile,
      judgeCapabilities: ['ghost_judge'],
    };
    const draftPath = writeDraft('bad.json', badDraft);
    // The sandbox has no physics dir; RL7 must refuse before creating anything.
    const exitCode = await runCli([draftPath, '--write', '--json'], { outputRoot: sandbox });

    expect(exitCode).toBe(1);
    // Nothing should have been written under the sandbox.
    expect(existsSync(join(sandbox, 'src', 'subjects', 'physics', 'profile.ts'))).toBe(false);
  });

  // Issues 2+3: existing-subject write goes to sandbox, never touches real physics/profile.ts.
  it('writes the serialized profile.ts for a valid draft (gate ALLOWS the write)', async () => {
    const sandbox = makeSandbox('rl7-allow');
    const draft = { ...physicsProfile, displayName: '物理 (compile smoke)' };
    const draftPath = writeDraft('valid.json', draft);

    const exitCode = await runCli([draftPath, '--write'], { outputRoot: sandbox });

    expect(exitCode).toBe(0);
    const written = join(sandbox, 'src', 'subjects', 'physics', 'profile.ts');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf-8')).toBe(serializeProfileToTs(draft));

    // Confirm the real src/subjects/physics/profile.ts was untouched.
    const realPath = join(process.cwd(), 'src', 'subjects', 'physics', 'profile.ts');
    expect(readFileSync(realPath, 'utf-8')).not.toContain('compile smoke');
  });

  // Issue 1 (Codex 3361129316): malicious id with path-traversal segments must be
  // rejected before any filesystem write. Proves the safe-id guard is on the
  // --write path and that zero bytes are written.
  it('refuses --write when draft id contains path traversal (Issue 1)', async () => {
    const sandbox = makeSandbox('rl7-traversal');
    const evilDraft = { ...physicsProfile, id: 'physics/../math' };
    const draftPath = writeDraft('evil.json', evilDraft);
    // Capture all output (log goes to stdout in non-json mode).
    const captured: string[] = [];
    const origLog = console.log.bind(console);
    const origErr = console.error.bind(console);
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    let exitCode: number;
    try {
      exitCode = await runCli([draftPath, '--write'], { outputRoot: sandbox });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    // Must be rejected with exit 1 and an error message naming the bad id.
    expect(exitCode).toBe(1);
    expect(captured.some((l) => l.includes('physics/../math'))).toBe(true);
  });

  // Issues 3+2 (Codex 3361129325, CR 3361255163): --write for a brand-new subject
  // id must succeed even when the subject directory does not yet exist. Uses a
  // unique time-based id so parallel runs can't collide; sandbox means no real dir
  // is ever created or needs cleanup outside tmpDir.
  it('creates missing subject directory for a new id (Issue 3)', async () => {
    const sandbox = makeSandbox('rl7-newdir');
    // Unique id — timestamp suffix avoids any possible collision with real subjects.
    const newId = `zztest${Date.now()}`;
    const draft = { ...wenyanProfile, id: newId };
    const draftPath = writeDraft('new-subject.json', draft);

    // Directory must NOT exist in the sandbox before the test.
    expect(existsSync(join(sandbox, 'src', 'subjects', newId))).toBe(false);

    const exitCode = await runCli([draftPath, '--write'], { outputRoot: sandbox });

    expect(exitCode).toBe(0);
    expect(existsSync(join(sandbox, 'src', 'subjects', newId, 'profile.ts'))).toBe(true);
    // Real src/subjects must be untouched.
    expect(existsSync(join(process.cwd(), 'src', 'subjects', newId))).toBe(false);
  });

  // Issue 2 (Codex 3361129322): --json --write output must be a single parseable
  // JSON object (not two separate JSON blobs or mixed text). Uses sandbox so no
  // real file is touched.
  it('--json --write emits exactly one JSON object on stdout (Issue 2)', async () => {
    const sandbox = makeSandbox('rl7-json');
    const draft = { ...physicsProfile, displayName: '物理 (json-write smoke)' };
    const draftPath = writeDraft('json-write.json', draft);
    const stdoutLines: string[] = [];
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map(String).join(' '));
    };
    try {
      const exitCode = await runCli([draftPath, '--write', '--json'], { outputRoot: sandbox });
      expect(exitCode).toBe(0);
      // Exactly one JSON.parse call must succeed on the joined output.
      const joined = stdoutLines.join('\n');
      const parsed = JSON.parse(joined) as { report: unknown; write_result?: { wrote: string } };
      expect(parsed.report).toBeDefined();
      expect(parsed.write_result?.wrote).toContain('physics');
    } finally {
      console.log = origLog;
    }
  });

  // Issue 4 (Codex 3361262860): --write for an id not in the default registry
  // must emit an actionable warning and set unregistered_subject:true in --json.
  it('warns when written subject id is not in the default registry (Issue 4)', async () => {
    const sandbox = makeSandbox('rl7-unreg');
    const unregId = `zzunreg${Date.now()}`;
    const draft = { ...wenyanProfile, id: unregId };
    const draftPath = writeDraft('unreg.json', draft);

    // Non-json mode: warning goes to stderr.
    const stderrLines: string[] = [];
    const origErr = console.error.bind(console);
    console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(' '));
    let exitCode: number;
    try {
      exitCode = await runCli([draftPath, '--write'], { outputRoot: sandbox });
    } finally {
      console.error = origErr;
    }
    expect(exitCode).toBe(0); // write succeeds; warning is non-fatal
    expect(stderrLines.some((l) => l.includes('NOT registered'))).toBe(true);
    expect(stderrLines.some((l) => l.includes('SubjectRegistry'))).toBe(true);
  });

  it('--json --write sets unregistered_subject:true for an unknown id (Issue 4)', async () => {
    const sandbox = makeSandbox('rl7-unreg-json');
    const unregId = `zzunregjson${Date.now()}`;
    const draft = { ...wenyanProfile, id: unregId };
    const draftPath = writeDraft('unreg-json.json', draft);

    const stdoutLines: string[] = [];
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => stdoutLines.push(args.map(String).join(' '));
    let exitCode: number;
    try {
      exitCode = await runCli([draftPath, '--write', '--json'], { outputRoot: sandbox });
    } finally {
      console.log = origLog;
    }
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutLines.join('\n')) as {
      report: unknown;
      unregistered_subject?: boolean;
    };
    expect(parsed.unregistered_subject).toBe(true);
  });
});
