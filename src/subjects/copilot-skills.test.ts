// YUK-284 (C2) — resolveCopilotSkills resolver unit tests.
//
// Test matrix (plan §4.6 T-C2-1/2/3):
//   - 命中：_shared/skills/copilot/SKILL.md exists → ['copilot']
//   - 降级：缺 _shared/skills/copilot/ → undefined
//   - 不误捞：fixture 含 copilot + 某 subject 的 note-*/quiz-gen-* → 只返回 ['copilot']
//   - live SoT：shipped _shared/skills/copilot/SKILL.md resolves against the real tree
//     + frontmatter name === 'copilot'
//
// All fixture assertions use an injected skillsRoot so no live filesystem writes
// happen except via the mkdtemp helpers here. No DB, no network — unit partition.
// NOTE: this file MUST be listed in fastTestInclude (vitest.shared.ts) — the unit
// partition is an explicit allowlist, not an import sniff (plan §4.6 P1).

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_SHARED_SUBJECT_DIR,
  COPILOT_SKILL_NAME,
  resolveCopilotSkills,
} from './copilot-skills';

// Build a fixture skills root with arbitrary <subjectDir>/skills/<skillDir>/SKILL.md.
function fixtureRoot(layout: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'copilotskills-'));
  for (const [subjectDir, skillDirs] of Object.entries(layout)) {
    for (const dir of skillDirs) {
      const skillDir = join(root, subjectDir, 'skills', dir);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${dir}\n---\n`);
    }
  }
  return root;
}

describe('resolveCopilotSkills — resolver discovery', () => {
  it("returns ['copilot'] when _shared/skills/copilot/SKILL.md exists", () => {
    const root = fixtureRoot({ [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME] });
    expect(resolveCopilotSkills(root)).toEqual(['copilot']);
  });
});

describe('resolveCopilotSkills — 降级链', () => {
  it('returns undefined when _shared has no skills dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'copilotskills-'));
    expect(resolveCopilotSkills(root)).toBeUndefined();
  });

  it('returns undefined when copilot/ dir exists but SKILL.md is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'copilotskills-'));
    mkdirSync(join(root, COPILOT_SHARED_SUBJECT_DIR, 'skills', COPILOT_SKILL_NAME), {
      recursive: true,
    });
    // no SKILL.md written
    expect(resolveCopilotSkills(root)).toBeUndefined();
  });
});

describe('resolveCopilotSkills — 不误捞 (缝隙防御)', () => {
  it('returns only [copilot], never note-* / quiz-gen-* even when both coexist', () => {
    const root = fixtureRoot({
      [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME],
      wenyan: ['note-wenyan', 'quiz-gen-translation'],
    });
    const result = resolveCopilotSkills(root);
    expect(result).toEqual(['copilot']);
    expect(result?.some((n) => n.startsWith('note-'))).toBe(false);
    expect(result?.some((n) => n.startsWith('quiz-gen-'))).toBe(false);
  });
});

describe('live SoT — shipped copilot SKILL.md resolves against the real tree', () => {
  // Uses the default skillsRoot (<cwd>/src/subjects) — verifies the authored
  // shared copilot pack is discoverable and has the correct frontmatter name.

  it("copilot skill is live and resolves to ['copilot']", () => {
    expect(resolveCopilotSkills()).toEqual(['copilot']);
  });

  it("SKILL.md frontmatter name === 'copilot'", () => {
    const skillFile = join(
      process.cwd(),
      'src',
      'subjects',
      COPILOT_SHARED_SUBJECT_DIR,
      'skills',
      COPILOT_SKILL_NAME,
      'SKILL.md',
    );
    const content = readFileSync(skillFile, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(frontmatterMatch, '_shared/skills/copilot/SKILL.md missing frontmatter').toBeTruthy();
    const frontmatter = frontmatterMatch?.[1];
    expect(frontmatter, "copilot SKILL.md name !== 'copilot'").toMatch(/^name:\s*copilot\s*$/m);
  });
});
