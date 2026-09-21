// YUK-225 (S2 slice 4) — (subject, kind) → Agent Skill doc resolution + 降级链.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §5.1 / §5.2(c)
//
// 规范双轨 轨 1: a per-题型 SKILL.md规范包 lives at
// src/subjects/<id>/skills/quiz-gen-<kind>/. A handler sets
// `ctx.piSkillDocs = await resolveQuizGenSkillDocs(subjectId, kind)`; the pi
// adapter injects the SKILL.md body into the system prompt. 出题 (QuizGenTask)
// 与验题 (QuizVerifyTask 的 kind_conformance 检查) 都用同一份 resolver →
// 出题验题同源 (task 要求 §5).
//
// 降级链 (spec §5): 缺 quiz-gen-<kind> skill 目录 → 不传 piSkillDocs（回退现状
// promptFragments），never throws. We resolve against the on-disk skill dirs so a
// missing pack degrades gracefully rather than injecting a name with no body.

import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubjectQuestionKind } from './profile-schema';
// YUK-226 S2-5b (PR #320 验证轮 A) — kind 词表规范化收编进单一权威模块.
//
// persisted `question.kind` (QuestionKind) ↔ profile/skill `SubjectQuestionKind` 的双向
// 映射现在只有一份实现，住在 ./question-kind.ts（canonical = 持久 QuestionKind），全链
// （route 校验 / sequence 池过滤 / pin 校验 / skill 解析）共用。这里 import + re-export 以
// 保持既有 import 路径稳定（skillDirName 仍按名引用），不再在本文件第二份手搓
// computation↔calculation 特例。
import { questionKindToSkillKind, skillKindToQuestionKind } from './question-kind';
// YUK-611 — 注入键从命名空间权威模块拼：<subjectId>--<pack>。
import { namespacedSkillName } from './skill-namespace';

export { questionKindToSkillKind, skillKindToQuestionKind };

// 题型 key 表 (spec §5「题型 key 表」): the subset of SubjectQuestionKind that has a
// dedicated quiz-gen skill naming convention. The skill DIRECTORY uses hyphens
// (quiz-gen-reading-comprehension) while the question-kind enum uses underscores
// (reading_comprehension); this map is the single translation point so callers
// never hand-roll the hyphen/underscore conversion.
export const QUIZ_GEN_SKILL_KIND_KEYS: Partial<Record<SubjectQuestionKind, string>> = {
  translation: 'translation',
  reading_comprehension: 'reading-comprehension',
  calculation: 'calculation',
};

function skillDirName(kind: SubjectQuestionKind): string | null {
  // Normalize a persisted QuestionKind ('computation') to its skill key
  // ('calculation') before lookup, so callers may pass EITHER enum's value
  // (quiz_verify hands the persisted question.kind; quiz_gen hands a profile kind).
  const key = QUIZ_GEN_SKILL_KIND_KEYS[questionKindToSkillKind(kind)];
  return key ? `quiz-gen-${key}` : null;
}

/**
 * Existence probe: does a (subject, kind) quiz-gen skill pack exist on disk?
 * Returns the pack's namespaced key (`<subjectId>--<dirName>`) when authored,
 * or `undefined` when absent. quiz_gen.ts uses this purely as a "skill-backed
 * kind" gate for few-shot retrieval — the piSkillDocs surface itself is served
 * by {@link resolveQuizGenSkillDocs}.
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a fixture
 * root. The SoT directory is the discovery anchor: a (subject, kind) whose skill
 * pack has not been authored yet resolves to undefined, NOT to a dead name.
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
  // 键 = 命名空间名 <subjectId>--<dirName>（YUK-611）——与 *SkillDocs resolver
  // 注入的 doc.name 同源。源树 frontmatter 保持裸目录名，name == 目录名
  // 由静态 audit（skill-namespace.test.ts）钉死。
  return [namespacedSkillName(subjectId, dirName)];
}

/**
 * Resolve ALL quiz-gen skill names a subject has authored (every
 * src/subjects/<id>/skills/quiz-gen-* with a SKILL.md). Kept as the cheap
 * existence probe backing the 缝隙防御 matrix (note-skills test asserts it
 * never returns note-*); the piSkillDocs surface is
 * {@link resolveQuizGenSkillDocsForSubject}.
 *
 * Returns undefined when the subject has no quiz-gen skill dir. skillsRoot
 * defaults to the live SoT; tests inject a fixture root.
 */
export async function resolveQuizGenSkillsForSubject(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<string[] | undefined> {
  const subjectSkillsDir = join(skillsRoot, subjectId, 'skills');
  let names: string[];
  try {
    // A missing skills dir throws ENOENT here (replaces the prior existsSync guard);
    // the catch degrades to undefined, same contract.
    const candidates = (await readdir(subjectSkillsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('quiz-gen-'))
      .map((d) => d.name);
    // existsSync inside the filter predicate would be an async-in-sync bug; check
    // every candidate's SKILL.md concurrently, then keep the ones that resolved.
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
  // 键 = 命名空间名（YUK-611），不是源树裸目录名。
  return names.length > 0 ? names.map((n) => namespacedSkillName(subjectId, n)) : undefined;
}

/**
 * The pi skill surface: resolved SKILL.md bodies the adapter injects into the
 * system prompt (pi has no filesystem skill loader). Keys are the same
 * namespaced names the existence probes emit. Per-pack degradation: a
 * missing/unreadable pack is skipped, never throws.
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
