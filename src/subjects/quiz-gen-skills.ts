// YUK-225 (S2 slice 4) — (subject, kind) → Agent Skill name resolution + 降级链.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §5.1 / §5.2(c)
//
// 规范双轨 轨 1: a per-题型 SKILL.md规范包 lives at
// src/subjects/<id>/skills/quiz-gen-<kind>/. The runner mirrors ALL of them into
// the isolated CLAUDE_CONFIG_DIR/skills once at process start; a handler then sets
// `ctx.skills = resolveQuizGenSkills(subjectId, kind)` to whitelist the ONE that
// applies (SDK context filter). 出题 (QuizGenTask) 与验题 (QuizVerifyTask 的
// kind_conformance 检查) 都用同一份 resolver → 出题验题同源 (task 要求 §5).
//
// 降级链 (spec §5): 缺 quiz-gen-<kind> skill 目录 → 不传 skills（回退现状
// promptFragments），never throws. We resolve against the on-disk skill dirs so a
// missing pack degrades gracefully rather than pointing the SDK at a name with no
// SKILL.md (which the SDK would just hide — but we keep the contract explicit).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SubjectQuestionKind } from './profile-schema';

// YUK-225 (S2 slice 4, PR #319 F3) — persisted-kind ↔ skill/profile-kind 规范化.
//
// Two enums name the same conceptual kind differently:
//   - persisted `question.kind` (core/schema/business.ts QuestionKind) uses
//     'computation' (and is what generated math rows are stored under, since
//     QuizGenOutput.kind validates against QuestionKind).
//   - profile / skill-key `SubjectQuestionKind` (profile-schema) uses 'calculation'
//     (math/physics profile.questionKinds, QUIZ_GEN_SKILL_KIND_KEYS, the
//     quiz-gen-calculation skill dir + its few-shot.json).
//
// The only divergent pair is computation ↔ calculation (route-resolve.ts:131 already
// treats them as one kind); every other kind matches by name. This single map is the
// canonical translation point so skill resolution AND few-shot retrieval agree on the
// key, instead of each side hand-rolling (and mismatching) the conversion.
const PERSISTED_TO_SKILL_KIND: Record<string, SubjectQuestionKind> = {
  computation: 'calculation',
};
const SKILL_TO_PERSISTED_KIND: Record<string, string> = {
  calculation: 'computation',
};

/**
 * Normalize a persisted `question.kind` value (core QuestionKind, e.g. 'computation')
 * to the profile/skill `SubjectQuestionKind` key (e.g. 'calculation') used by
 * QUIZ_GEN_SKILL_KIND_KEYS and the skill directory layout. Kinds that already match
 * pass through unchanged.
 */
export function questionKindToSkillKind(persistedKind: string): SubjectQuestionKind {
  return PERSISTED_TO_SKILL_KIND[persistedKind] ?? (persistedKind as SubjectQuestionKind);
}

/**
 * Inverse of {@link questionKindToSkillKind}: map a profile/skill `SubjectQuestionKind`
 * (e.g. 'calculation') to the persisted `question.kind` value (e.g. 'computation')
 * that rows are stored under, so a `WHERE kind = …` few-shot filter matches real rows.
 */
export function skillKindToQuestionKind(skillKind: SubjectQuestionKind): string {
  return SKILL_TO_PERSISTED_KIND[skillKind] ?? skillKind;
}

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
 * Resolve the quiz-gen Agent Skill whitelist for a (subject, kind). Returns the
 * skill name array to pass as `ctx.skills`, or `undefined` when no skill pack
 * exists on disk for that (subject, kind) — the 降级链 (caller passes no skills
 * option → SDK loads nothing extra → promptFragments fallback).
 *
 * skillsRoot defaults to <cwd>/src/subjects (the live SoT). Tests inject a fixture
 * root. The SoT directory is the discovery anchor: a (subject, kind) whose skill
 * pack has not been authored yet resolves to undefined, NOT to a dead name.
 */
export function resolveQuizGenSkills(
  subjectId: string,
  kind: SubjectQuestionKind,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): string[] | undefined {
  const dirName = skillDirName(kind);
  if (!dirName) return undefined;
  const skillDir = join(skillsRoot, subjectId, 'skills', dirName);
  if (!existsSync(join(skillDir, 'SKILL.md'))) return undefined;
  // The SKILL.md `name` frontmatter == directory name (authored that way), and
  // the SDK matches `Options.skills` against that name. So the directory name is
  // the whitelist key.
  return [dirName];
}

/**
 * Resolve ALL quiz-gen skill names a subject has authored (every
 * src/subjects/<id>/skills/quiz-gen-* with a SKILL.md). Used by QuizGen where a
 * single run can emit MIXED question kinds (§5.2(c)): we whitelist every quiz-gen
 * pack the subject owns so the model can pull whichever规范包 fits each item it
 * writes; unauthored kinds simply have no pack (降级链 → no skill for that kind).
 * Returns undefined when the subject has no quiz-gen skill dir (降级: no skills
 * option). skillsRoot defaults to the live SoT; tests inject a fixture root.
 */
export function resolveQuizGenSkillsForSubject(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): string[] | undefined {
  const subjectSkillsDir = join(skillsRoot, subjectId, 'skills');
  if (!existsSync(subjectSkillsDir)) return undefined;
  let names: string[];
  try {
    names = readdirSync(subjectSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('quiz-gen-'))
      .filter((d) => existsSync(join(subjectSkillsDir, d.name, 'SKILL.md')))
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  return names.length > 0 ? names : undefined;
}
