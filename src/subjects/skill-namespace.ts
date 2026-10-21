// Single source for skill injection keys: `<subjectDir>--<pack>`. Bare directory
// names collide across subjects; the double hyphen is unambiguous because both
// sides contain only single hyphens.

export const SKILL_NAMESPACE_SEPARATOR = '--';

export function namespacedSkillName(subjectDir: string, skillDirName: string): string {
  return `${subjectDir}${SKILL_NAMESPACE_SEPARATOR}${skillDirName}`;
}

/**
 * Returns null when the first frontmatter name line is absent or differs from
 * the directory name; otherwise the rewritten document.
 */
export function rewriteSkillMdName(
  content: string,
  dirName: string,
  namespaced: string,
): string | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return null;
    const m = line.match(/^name:\s*(.+?)\s*$/);
    if (m) {
      if (m[1] !== dirName) return null;
      lines[i] = `name: ${namespaced}`;
      return lines.join('\n');
    }
  }
  return null;
}
