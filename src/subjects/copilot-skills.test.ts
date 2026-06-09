// YUK-284 (C2) + YUK-304 (lane B) — resolveCopilotSkills resolver unit tests.
//
// Test matrix (C2 T-C2-1/2/3, extended for the lane-B quiz-gen pack):
//   - 双包命中：copilot + quiz-gen 都在 → ['copilot','quiz-gen'] (probe order)
//   - 单包命中：只有其一 → 只返回那一个
//   - 降级：全缺 → undefined
//   - 不误捞：fixture 含某 subject 的 note-*/quiz-gen-<kind> → 不会捞进共享白名单
//   - live SoT：shipped 两个共享包 resolve against the real tree + frontmatter name
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
  COPILOT_QUIZ_GEN_SKILL_NAME,
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
  it("returns ['copilot','quiz-gen'] when BOTH shared packs exist (probe order)", async () => {
    const root = fixtureRoot({
      [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME],
    });
    expect(await resolveCopilotSkills(root)).toEqual([
      COPILOT_SKILL_NAME,
      COPILOT_QUIZ_GEN_SKILL_NAME,
    ]);
  });

  it("returns ['copilot'] when only the dialogue pack exists", async () => {
    const root = fixtureRoot({ [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME] });
    expect(await resolveCopilotSkills(root)).toEqual([COPILOT_SKILL_NAME]);
  });

  it("returns ['quiz-gen'] when only the quiz-gen pack exists", async () => {
    const root = fixtureRoot({ [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_QUIZ_GEN_SKILL_NAME] });
    expect(await resolveCopilotSkills(root)).toEqual([COPILOT_QUIZ_GEN_SKILL_NAME]);
  });
});

describe('resolveCopilotSkills — 降级链', () => {
  it('returns undefined when _shared has no skills dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copilotskills-'));
    expect(await resolveCopilotSkills(root)).toBeUndefined();
  });

  it('returns undefined when the dirs exist but SKILL.md files are missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copilotskills-'));
    for (const name of [COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME]) {
      mkdirSync(join(root, COPILOT_SHARED_SUBJECT_DIR, 'skills', name), { recursive: true });
    }
    // no SKILL.md written
    expect(await resolveCopilotSkills(root)).toBeUndefined();
  });
});

describe('resolveCopilotSkills — 不误捞 (缝隙防御)', () => {
  it('returns only the shared packs, never note-* / quiz-gen-<kind> subject packs', async () => {
    const root = fixtureRoot({
      [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME],
      // quiz-gen-translation is the per-题型 namespace (quiz-gen-skills.ts) — its
      // resolver builds `quiz-gen-<key>` names exactly, so the bare 'quiz-gen'
      // shared pack can never collide; assert the reverse direction here.
      wenyan: ['note-wenyan', 'quiz-gen-translation'],
    });
    const result = await resolveCopilotSkills(root);
    expect(result).toEqual([COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME]);
    expect(result?.some((n) => n.startsWith('note-'))).toBe(false);
    expect(result).not.toContain('quiz-gen-translation');
  });
});

describe('live SoT — shipped shared SKILL.md packs resolve against the real tree', () => {
  // Uses the default skillsRoot (<cwd>/src/subjects) — verifies the authored
  // shared packs are discoverable and carry the correct frontmatter names.

  it("both shared packs are live and resolve to ['copilot','quiz-gen']", async () => {
    expect(await resolveCopilotSkills()).toEqual([COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME]);
  });

  it.each([COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME])(
    "SKILL.md frontmatter name === '%s'",
    (name) => {
      const skillFile = join(
        process.cwd(),
        'src',
        'subjects',
        COPILOT_SHARED_SUBJECT_DIR,
        'skills',
        name,
        'SKILL.md',
      );
      const content = readFileSync(skillFile, 'utf-8');
      const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(frontmatterMatch, `_shared/skills/${name}/SKILL.md missing frontmatter`).toBeTruthy();
      const frontmatter = frontmatterMatch?.[1];
      expect(frontmatter, `${name} SKILL.md name !== '${name}'`).toMatch(
        new RegExp(`^name:\\s*${name}\\s*$`, 'm'),
      );
    },
  );
});
