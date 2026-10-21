// Copilot and quiz-gen methodology packs are cross-subject, so both live under
// the non-subject `_shared` directory. Packs are probed on disk; a missing pack
// is simply not injected and callers fall back to prompt prose. Never throws.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { namespacedSkillName } from './skill-namespace';

// Placement convention, not a registered subject; the underscore marks it as
// non-subject.
export const COPILOT_SHARED_SUBJECT_DIR = '_shared';
export const COPILOT_SKILL_NAME = 'copilot';
export const COPILOT_QUIZ_GEN_SKILL_NAME = 'quiz-gen';

// Dialogue methodology first, then the quiz-gen pack.
const COPILOT_SHARED_SKILL_NAMES = [COPILOT_SKILL_NAME, COPILOT_QUIZ_GEN_SKILL_NAME] as const;

/**
 * Resolve the shared Copilot skill bodies. Returns the found subset, or undefined
 * when neither pack exists so callers can fall back to prompt prose.
 */
export async function resolveCopilotSkillDocs(
  skillsRoot: string = join(process.cwd(), 'src', 'subjects'),
): Promise<{ name: string; body: string }[] | undefined> {
  const found: { name: string; body: string }[] = [];
  for (const name of COPILOT_SHARED_SKILL_NAMES) {
    const skillFile = join(skillsRoot, COPILOT_SHARED_SUBJECT_DIR, 'skills', name, 'SKILL.md');
    try {
      const body = await readFile(skillFile, 'utf8');
      if (body.length === 0) continue;
      found.push({ name: namespacedSkillName(COPILOT_SHARED_SUBJECT_DIR, name), body });
    } catch {
      // Missing pack: per-pack degradation, never throws.
    }
  }
  return found.length > 0 ? found : undefined;
}
