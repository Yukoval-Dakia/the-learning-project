// Resolves the subject-level Note skill pack shared by the three note tasks.
// A missing pack returns undefined so callers fall back to prompt prose; never
// throws. The directory keeps its historical `note-<id>` name and is exposed
// under the namespaced key, disjoint from the quiz-gen packs.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { namespacedSkillName } from './skill-namespace';

/**
 * Returns the Note skill body for a subject, or undefined when no pack exists.
 */
export async function resolveNoteSkillDoc(
  subjectId: string,
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<{ name: string; body: string }[] | undefined> {
  const noteSkillDir = `note-${subjectId}`;
  try {
    const body = await readFile(
      join(skillsRoot, subjectId, 'skills', noteSkillDir, 'SKILL.md'),
      'utf8',
    );
    if (body.length === 0) return undefined;
    return [{ name: namespacedSkillName(subjectId, noteSkillDir), body }];
  } catch {
    return undefined;
  }
}
