// YUK-228 (S3 Slice B) — note-skills resolver unit tests.
//
// Test matrix (plan §2 Slice B):
//   - resolver 发现：yuwen/math/physics have note skill → ['note-<subjectId>']
//   - resolver 不误捞：resolveNoteSkillDoc 不返回 quiz-gen-*；
//     resolveQuizGenSkillsForSubject 不返回 note-*（双向缝隙防御）
//   - 降级链：缺 note 目录 → undefined
//   - SKILL.md frontmatter name === 'note-<subjectId>'（== 目录名，三科都断言）
//
// All assertions use a fixture skillsRoot (injected via second param) so
// no live filesystem writes happen except via the mkdtemp helpers here.
// No DB, no network — unit partition.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNoteSkillDoc } from './note-skills';
import { resolveQuizGenSkillsForSubject } from './quiz-gen-skills';

// Build a fixture skills root with note-<subject>/ and/or quiz-gen-* directories.
function fixtureRoot(layout: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'noteskills-'));
  for (const [subject, skillDirs] of Object.entries(layout)) {
    for (const dir of skillDirs) {
      const skillDir = join(root, subject, 'skills', dir);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${dir}\n---\nbody text\n`);
    }
  }
  return root;
}

describe('resolveNoteSkillDoc — resolver discovery', () => {
  it("returns [{name:'yuwen--note-yuwen'}] when note-yuwen/SKILL.md exists (YUK-611 namespaced)", async () => {
    const root = fixtureRoot({ yuwen: ['note-yuwen'] });
    const docs = await resolveNoteSkillDoc('yuwen', root);
    expect(docs?.map((d) => d.name)).toEqual(['yuwen--note-yuwen']);
    expect(docs?.[0]?.body).toContain('name: note-yuwen');
  });

  it('works for math subject', async () => {
    const root = fixtureRoot({ math: ['note-math'] });
    expect((await resolveNoteSkillDoc('math', root))?.map((d) => d.name)).toEqual([
      'math--note-math',
    ]);
  });

  it('works for physics subject', async () => {
    const root = fixtureRoot({ physics: ['note-physics'] });
    expect((await resolveNoteSkillDoc('physics', root))?.map((d) => d.name)).toEqual([
      'physics--note-physics',
    ]);
  });
});

describe('resolveNoteSkillDoc — 降级链', () => {
  it('returns undefined when the subject has no skills dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noteskills-'));
    expect(await resolveNoteSkillDoc('unknown_subject', root)).toBeUndefined();
  });

  it('returns undefined when note-yuwen/ dir exists but SKILL.md is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noteskills-'));
    mkdirSync(join(root, 'yuwen', 'skills', 'note-yuwen'), { recursive: true });
    // no SKILL.md written
    expect(await resolveNoteSkillDoc('yuwen', root)).toBeUndefined();
  });

  it('returns undefined for a subject that only has quiz-gen skills (no note)', async () => {
    const root = fixtureRoot({ yuwen: ['quiz-gen-translation'] });
    expect(await resolveNoteSkillDoc('yuwen', root)).toBeUndefined();
  });
});

describe('resolveNoteSkillDoc — 缝隙防御 (S2 第二教训)', () => {
  it('resolveNoteSkillDoc does not return quiz-gen-* names', async () => {
    const root = fixtureRoot({ yuwen: ['note-yuwen', 'quiz-gen-translation'] });
    const result = await resolveNoteSkillDoc('yuwen', root);
    expect(result?.map((d) => d.name)).toEqual(['yuwen--note-yuwen']);
    // 命名空间名形如 <subject>--<pack>，缝隙防御改按 pack 段判（YUK-611）。
    expect(result?.some((d) => d.name.includes('quiz-gen-'))).toBe(false);
  });

  it('resolveQuizGenSkillsForSubject does not return note-*', async () => {
    const root = fixtureRoot({ yuwen: ['note-yuwen', 'quiz-gen-translation'] });
    const result = await resolveQuizGenSkillsForSubject('yuwen', root);
    expect(result).toEqual(['yuwen--quiz-gen-translation']);
    expect(result?.some((n) => n.includes('--note-'))).toBe(false);
  });
});

describe('live SoT — shipped SKILL.md files resolve against the real tree', () => {
  // Uses the default skillsRoot (<cwd>/src/subjects) — verifies the three authored
  // note packs are discoverable and have the correct frontmatter name.

  it('yuwen note skill is live and resolves namespaced', async () => {
    expect((await resolveNoteSkillDoc('yuwen'))?.map((d) => d.name)).toEqual(['yuwen--note-yuwen']);
  });

  it('math note skill is live and resolves namespaced', async () => {
    expect((await resolveNoteSkillDoc('math'))?.map((d) => d.name)).toEqual(['math--note-math']);
  });

  it('physics note skill is live and resolves namespaced', async () => {
    expect((await resolveNoteSkillDoc('physics'))?.map((d) => d.name)).toEqual([
      'physics--note-physics',
    ]);
  });

  it('SKILL.md frontmatter name === note-<subject> for all three subjects', () => {
    for (const subject of ['yuwen', 'math', 'physics']) {
      const skillFile = join(
        process.cwd(),
        'src',
        'subjects',
        subject,
        'skills',
        `note-${subject}`,
        'SKILL.md',
      );
      const content = readFileSync(skillFile, 'utf-8');
      // frontmatter block is between the two --- lines; name: note-<subject> must appear
      const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(
        frontmatterMatch,
        `${subject}/skills/note-${subject}/SKILL.md missing frontmatter`,
      ).toBeTruthy();
      const frontmatter = frontmatterMatch?.[1];
      expect(frontmatter, `${subject} SKILL.md name !== 'note-${subject}'`).toMatch(
        new RegExp(`^name:\\s*note-${subject}\\s*$`, 'm'),
      );
    }
  });
});
