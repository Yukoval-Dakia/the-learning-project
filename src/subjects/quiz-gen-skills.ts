// Per-kind quiz-gen skill resolution. Packs are read from disk; a missing pack
// returns undefined so callers fall back to prompt prose and never inject a name
// without a body. Quiz generation and verification share this resolver.

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type SubjectQuestionKind, SubjectQuestionKindSchema } from './profile-schema';
// Vocabulary normalization has one owner; re-exported to keep import paths stable.
import { questionKindToSkillKind, skillKindToQuestionKind } from './question-kind';
import { namespacedSkillName } from './skill-namespace';

export { questionKindToSkillKind, skillKindToQuestionKind };

// Underscored enum values map to hyphenated directory names here, the single
// translation point.
export const QUIZ_GEN_SKILL_KIND_KEYS: Partial<Record<SubjectQuestionKind, string>> = {
  translation: 'translation',
  reading_comprehension: 'reading-comprehension',
  calculation: 'calculation',
};

function skillDirName(kind: SubjectQuestionKind): string | null {
  // Accept either vocabulary: persisted 'computation' or profile 'calculation'.
  const parsed = SubjectQuestionKindSchema.safeParse(questionKindToSkillKind(kind));
  const key = parsed.success ? QUIZ_GEN_SKILL_KIND_KEYS[parsed.data] : undefined;
  return key ? `quiz-gen-${key}` : null;
}

/**
 * Existence probe for one (subject, kind) pack. Returns the namespaced key, or
 * undefined when the pack has not been authored — never a dead name.
 */
export async function resolveQuizGenSkills(
  subjectId: string,
  kind: SubjectQuestionKind,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<string[] | undefined> {
  const dirName = skillDirName(kind);
  if (!dirName) return undefined;
  const skillDir = join(skillsRoot, subjectId, 'skills', dirName);
  try {
    await access(join(skillDir, 'SKILL.md'));
  } catch {
    return undefined;
  }
  // Same namespaced keys the docs resolvers emit.
  return [namespacedSkillName(subjectId, dirName)];
}

/**
 * All quiz-gen pack keys a subject has authored; undefined when it has none.
 */
export async function resolveQuizGenSkillsForSubject(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<string[] | undefined> {
  const subjectSkillsDir = join(skillsRoot, subjectId, 'skills');
  let names: string[];
  try {
    const candidates = (await readdir(subjectSkillsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('quiz-gen-'))
      .map((d) => d.name);
    // Check SKILL.md concurrently; a sync filter would block the event loop.
    const hasSkillFile = await Promise.all(
      candidates.map((name) =>
        access(join(subjectSkillsDir, name, 'SKILL.md')).then(
          () => true,
          () => false,
        ),
      ),
    );
    names = candidates.filter((_, i) => hasSkillFile[i]);
  } catch {
    return undefined;
  }
  return names.length > 0 ? names.map((n) => namespacedSkillName(subjectId, n)) : undefined;
}

/**
 * Resolved bodies for the pi prompt. A missing pack is skipped, never thrown.
 */
async function readSkillDoc(
  skillsRoot: string,
  subjectId: string,
  dirName: string,
): Promise<{ name: string; body: string } | undefined> {
  try {
    const body = await readFile(join(skillsRoot, subjectId, 'skills', dirName, 'SKILL.md'), 'utf8');
    if (body.length === 0) return undefined;
    return { name: namespacedSkillName(subjectId, dirName), body };
  } catch {
    return undefined;
  }
}

/** Skill doc surface for one (subject, kind) pack — the injected body. */
export async function resolveQuizGenSkillDocs(
  subjectId: string,
  kind: SubjectQuestionKind,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<{ name: string; body: string }[] | undefined> {
  const dirName = skillDirName(kind);
  if (!dirName) return undefined;
  const doc = await readSkillDoc(skillsRoot, subjectId, dirName);
  return doc ? [doc] : undefined;
}

/** Skill doc surface for every authored quiz-gen pack of a subject. */
export async function resolveQuizGenSkillDocsForSubject(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<{ name: string; body: string }[] | undefined> {
  const subjectSkillsDir = join(skillsRoot, subjectId, 'skills');
  let dirNames: string[];
  try {
    dirNames = (await readdir(subjectSkillsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('quiz-gen-'))
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  const docs = (
    await Promise.all(dirNames.map((n) => readSkillDoc(skillsRoot, subjectId, n)))
  ).filter((d): d is { name: string; body: string } => d !== undefined);
  return docs.length > 0 ? docs : undefined;
}
