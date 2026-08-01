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
  it("returns ['_shared--copilot','_shared--quiz-gen'] when BOTH shared packs exist (probe order, YUK-611 namespaced)", async () => {
    const root = fixtureRoot({
      [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME],
    });
    expect(await resolveCopilotSkills(root)).toEqual(['_shared--copilot', '_shared--quiz-gen']);
  });

  it("returns ['_shared--copilot'] when only the dialogue pack exists", async () => {
    const root = fixtureRoot({ [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_SKILL_NAME] });
    expect(await resolveCopilotSkills(root)).toEqual(['_shared--copilot']);
  });

  it("returns ['_shared--quiz-gen'] when only the quiz-gen pack exists", async () => {
    const root = fixtureRoot({ [COPILOT_SHARED_SUBJECT_DIR]: [COPILOT_QUIZ_GEN_SKILL_NAME] });
    expect(await resolveCopilotSkills(root)).toEqual(['_shared--quiz-gen']);
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
      yuwen: ['note-yuwen', 'quiz-gen-translation'],
    });
    const result = await resolveCopilotSkills(root);
    expect(result).toEqual(['_shared--copilot', '_shared--quiz-gen']);
    expect(result?.some((n) => n.includes('--note-'))).toBe(false);
    expect(result).not.toContain('quiz-gen-translation');
    expect(result).not.toContain('yuwen--quiz-gen-translation');
  });
});

describe('live SoT — shipped shared SKILL.md packs resolve against the real tree', () => {
  // Uses the default skillsRoot (<cwd>/src/subjects) — verifies the authored
  // shared packs are discoverable and carry the correct frontmatter names.

  it("both shared packs are live and resolve to ['_shared--copilot','_shared--quiz-gen']", async () => {
    expect(await resolveCopilotSkills()).toEqual(['_shared--copilot', '_shared--quiz-gen']);
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

  it('YUK-757 — dialogue methodology delegates only genuinely heavy focused work', () => {
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
    expect(content).toContain('什么时候派后台研究员');
    expect(content).toContain('跨 artifact 深检索');
    expect(content).toContain('复杂出题预览');
    expect(content).toContain('诊断解释');
    expect(content).toContain('短任务不要派');
    expect(content).toContain('只把结论交回主 Copilot');
  });

  it('YUK-832 — dialogue methodology pins evidence-reader semantics and bounded claims', () => {
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
    expect(content).toContain('YUK-832 evidence-reading contract');
    expect(content).toContain('action 与 event id 都按工具声明的 **exact**');
    expect(content).toContain('`causedByEventId` 只表示 **direct children**');
    expect(content).toContain('共享同一个非空 parent');
    expect(content).toContain('以 `dispatch_seq` 判断真实插入顺序');
    expect(content).toContain('都先检查 `correction_state`');
    expect(content).toContain('0 rows 只证明当前 filter 与时间 window');
    expect(content).toContain('due-now queue 为空，不等于 schedule absent');
    expect(content).toContain('不得只因后续一次空读就反转为「不存在」');
    expect(content).toContain('不要用字符串相似、正则或自由文本 NLP 代替验证');
  });
});
