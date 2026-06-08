import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUIZ_GEN_SKILL_KIND_KEYS,
  questionKindToSkillKind,
  resolveQuizGenSkills,
  resolveQuizGenSkillsForSubject,
  skillKindToQuestionKind,
} from './quiz-gen-skills';

// Build a fixture skills root: <root>/<subject>/skills/<dir>/SKILL.md
function fixtureRoot(layout: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'qgskills-'));
  for (const [subject, skillDirs] of Object.entries(layout)) {
    for (const dir of skillDirs) {
      const skillDir = join(root, subject, 'skills', dir);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${dir}\n---\n`);
    }
  }
  return root;
}

describe('resolveQuizGenSkills (per (subject, kind))', () => {
  it('returns the hyphenated skill dir name when a pack exists', async () => {
    const root = fixtureRoot({ wenyan: ['quiz-gen-translation'] });
    expect(await resolveQuizGenSkills('wenyan', 'translation', root)).toEqual([
      'quiz-gen-translation',
    ]);
  });

  it('translates underscore kind to hyphen dir (reading_comprehension)', async () => {
    const root = fixtureRoot({ wenyan: ['quiz-gen-reading-comprehension'] });
    expect(await resolveQuizGenSkills('wenyan', 'reading_comprehension', root)).toEqual([
      'quiz-gen-reading-comprehension',
    ]);
  });

  it('降级链: returns undefined when the pack dir is absent (unauthored kind)', async () => {
    const root = fixtureRoot({ wenyan: ['quiz-gen-translation'] });
    expect(await resolveQuizGenSkills('wenyan', 'reading_comprehension', root)).toBeUndefined();
  });

  it('降级链: returns undefined for a kind with no skill-key mapping', async () => {
    const root = fixtureRoot({ math: ['quiz-gen-calculation'] });
    // single_choice has no entry in QUIZ_GEN_SKILL_KIND_KEYS
    expect(await resolveQuizGenSkills('math', 'single_choice', root)).toBeUndefined();
  });

  it('降级链: returns undefined when SKILL.md is missing even if dir exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qgskills-'));
    mkdirSync(join(root, 'wenyan', 'skills', 'quiz-gen-translation'), { recursive: true });
    // no SKILL.md written
    expect(await resolveQuizGenSkills('wenyan', 'translation', root)).toBeUndefined();
  });
});

describe('resolveQuizGenSkillsForSubject (all packs)', () => {
  it('returns every quiz-gen pack the subject authored', async () => {
    const root = fixtureRoot({
      wenyan: ['quiz-gen-translation', 'quiz-gen-reading-comprehension'],
    });
    const result = await resolveQuizGenSkillsForSubject('wenyan', root);
    expect(result).toEqual(
      expect.arrayContaining(['quiz-gen-translation', 'quiz-gen-reading-comprehension']),
    );
    expect(result).toHaveLength(2);
  });

  it('ignores non quiz-gen dirs', async () => {
    const root = fixtureRoot({ wenyan: ['quiz-gen-translation', 'some-other-skill'] });
    expect(await resolveQuizGenSkillsForSubject('wenyan', root)).toEqual(['quiz-gen-translation']);
  });

  it('降级链: returns undefined when the subject has no skills dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qgskills-'));
    expect(await resolveQuizGenSkillsForSubject('physics', root)).toBeUndefined();
  });
});

describe('the shipped first-batch skills resolve against the live SoT', () => {
  // Uses the default skillsRoot (<cwd>/src/subjects) — verifies the actual
  // authored packs are discoverable, guarding the directory naming convention.
  it('wenyan translation + reading_comprehension + math calculation are live', async () => {
    expect(await resolveQuizGenSkills('wenyan', 'translation')).toEqual(['quiz-gen-translation']);
    expect(await resolveQuizGenSkills('wenyan', 'reading_comprehension')).toEqual([
      'quiz-gen-reading-comprehension',
    ]);
    expect(await resolveQuizGenSkills('math', 'calculation')).toEqual(['quiz-gen-calculation']);
  });

  // PR #319 F3 — the persisted question.kind for math calculation questions is
  // 'computation' (core QuestionKind), NOT 'calculation' (SubjectQuestionKind). When
  // quiz_verify hands the PERSISTED kind to resolveQuizGenSkills, it must still resolve
  // to quiz-gen-calculation via the normalization map; otherwise the verifier loads no
  // math skill and kind_conformance silently degrades.
  it('resolves the persisted kind (computation) to quiz-gen-calculation', async () => {
    // `as never` mirrors the quiz_verify call site casting a persisted QuestionKind
    // string into the SubjectQuestionKind param; the normalizer accepts it.
    expect(await resolveQuizGenSkills('math', 'computation' as never)).toEqual([
      'quiz-gen-calculation',
    ]);
  });
});

describe('kind normalization (persisted QuestionKind ↔ skill SubjectQuestionKind)', () => {
  it('questionKindToSkillKind maps computation → calculation, passes others through', () => {
    expect(questionKindToSkillKind('computation')).toBe('calculation');
    expect(questionKindToSkillKind('translation')).toBe('translation');
    expect(questionKindToSkillKind('reading_comprehension')).toBe('reading_comprehension');
  });

  it('skillKindToQuestionKind maps calculation → computation, passes others through', () => {
    expect(skillKindToQuestionKind('calculation')).toBe('computation');
    expect(skillKindToQuestionKind('translation')).toBe('translation');
  });

  it('round-trips computation/calculation', () => {
    expect(skillKindToQuestionKind(questionKindToSkillKind('computation'))).toBe('computation');
    expect(questionKindToSkillKind(skillKindToQuestionKind('calculation'))).toBe('calculation');
  });
});

describe('QUIZ_GEN_SKILL_KIND_KEYS', () => {
  it('covers the first-batch kinds (OF-3)', () => {
    expect(QUIZ_GEN_SKILL_KIND_KEYS.translation).toBe('translation');
    expect(QUIZ_GEN_SKILL_KIND_KEYS.reading_comprehension).toBe('reading-comprehension');
    expect(QUIZ_GEN_SKILL_KIND_KEYS.calculation).toBe('calculation');
  });
});
