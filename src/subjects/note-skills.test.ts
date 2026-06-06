// YUK-228 (S3 Slice B) — note-skills resolver unit tests.
//
// Test matrix (plan §2 Slice B):
//   - resolver 发现：wenyan/math/physics have note skill → ['note']
//   - resolver 不误捞：resolveNoteSkill 不返回 quiz-gen-*；
//     resolveQuizGenSkillsForSubject 不返回 note（双向缝隙防御）
//   - 降级链：缺 note 目录 → undefined
//   - SKILL.md frontmatter name === 'note'（== 目录名，三科都断言）
//
// All assertions use a fixture skillsRoot (injected via second param) so
// no live filesystem writes happen except via the mkdtemp helpers here.
// No DB, no network — unit partition.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNoteSkill } from './note-skills';
import { resolveQuizGenSkillsForSubject } from './quiz-gen-skills';

// Build a fixture skills root with note/ and/or quiz-gen-* directories.
function fixtureRoot(layout: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'noteskills-'));
  for (const [subject, skillDirs] of Object.entries(layout)) {
    for (const dir of skillDirs) {
      const skillDir = join(root, subject, 'skills', dir);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${dir}\n---\n`);
    }
  }
  return root;
}

describe('resolveNoteSkill — resolver discovery', () => {
  it("returns ['note'] when note/SKILL.md exists for the subject", () => {
    const root = fixtureRoot({ wenyan: ['note'] });
    expect(resolveNoteSkill('wenyan', root)).toEqual(['note']);
  });

  it('works for math subject', () => {
    const root = fixtureRoot({ math: ['note'] });
    expect(resolveNoteSkill('math', root)).toEqual(['note']);
  });

  it('works for physics subject', () => {
    const root = fixtureRoot({ physics: ['note'] });
    expect(resolveNoteSkill('physics', root)).toEqual(['note']);
  });
});

describe('resolveNoteSkill — 降级链', () => {
  it('returns undefined when the subject has no skills dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'noteskills-'));
    expect(resolveNoteSkill('unknown_subject', root)).toBeUndefined();
  });

  it('returns undefined when note/ dir exists but SKILL.md is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'noteskills-'));
    mkdirSync(join(root, 'wenyan', 'skills', 'note'), { recursive: true });
    // no SKILL.md written
    expect(resolveNoteSkill('wenyan', root)).toBeUndefined();
  });

  it('returns undefined for a subject that only has quiz-gen skills (no note)', () => {
    const root = fixtureRoot({ wenyan: ['quiz-gen-translation'] });
    expect(resolveNoteSkill('wenyan', root)).toBeUndefined();
  });
});

describe('resolveNoteSkill — 缝隙防御 (S2 第二教训)', () => {
  it('resolveNoteSkill does not return quiz-gen-* names', () => {
    const root = fixtureRoot({ wenyan: ['note', 'quiz-gen-translation'] });
    const result = resolveNoteSkill('wenyan', root);
    expect(result).toEqual(['note']);
    expect(result?.some((n) => n.startsWith('quiz-gen-'))).toBe(false);
  });

  it('resolveQuizGenSkillsForSubject does not return note', () => {
    const root = fixtureRoot({ wenyan: ['note', 'quiz-gen-translation'] });
    const result = resolveQuizGenSkillsForSubject('wenyan', root);
    expect(result).toEqual(['quiz-gen-translation']);
    expect(result?.includes('note')).toBe(false);
  });
});

describe('live SoT — shipped SKILL.md files resolve against the real tree', () => {
  // Uses the default skillsRoot (<cwd>/src/subjects) — verifies the three authored
  // note packs are discoverable and have the correct frontmatter name.

  it('wenyan note skill is live and name === note', () => {
    expect(resolveNoteSkill('wenyan')).toEqual(['note']);
  });

  it('math note skill is live and name === note', () => {
    expect(resolveNoteSkill('math')).toEqual(['note']);
  });

  it('physics note skill is live and name === note', () => {
    expect(resolveNoteSkill('physics')).toEqual(['note']);
  });

  it('SKILL.md frontmatter name === note for all three subjects', () => {
    for (const subject of ['wenyan', 'math', 'physics']) {
      const skillFile = join(
        process.cwd(),
        'src',
        'subjects',
        subject,
        'skills',
        'note',
        'SKILL.md',
      );
      const content = readFileSync(skillFile, 'utf-8');
      // frontmatter block is between the two --- lines; name: note must appear
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch, `${subject}/skills/note/SKILL.md missing frontmatter`).toBeTruthy();
      const frontmatter = frontmatterMatch?.[1];
      expect(frontmatter, `${subject} SKILL.md name !== 'note'`).toMatch(/^name:\s*note\s*$/m);
    }
  });
});
