// YUK-611 — skill 命名空间单一权威模块。
//
// runner 的 populateIsolatedSkills 把所有 src/subjects/<dir>/skills/* 扁平镜像进
// 同一个 CLAUDE_CONFIG_DIR/skills/ 命名空间；SDK 按 SKILL.md `name` frontmatter
// （成文约定 == 目录名）匹配 Options.skills 白名单。目录 basename 因此曾是全局键：
// 跨科同名目录在镜像里静默互踩（拷贝顺序决定谁活），构建期运行期双无告警——今日
// 三科不撞是巧合不是约束（note-* 自发带科目后缀，quiz-gen-* 没有）。
//
// 防线两半（YUK-597 v3 契约 §5.2 ②）：
//   1. 镜像目录名 + 镜像内 frontmatter name 统一命名空间化 `<subjectDir>--<pack>`
//      （populate 时改写，源树保持裸名）；三个 resolver（quiz-gen / note / copilot）
//      从本模块拼白名单名，与镜像键永远同源。`_shared` 伪目录同规则（`_shared--copilot`）。
//   2. 构建期静态 audit（skill-namespace.test.ts）：跨科 basename 重复即红 +
//      frontmatter name 必须 == 目录名（下面 rewrite 锚点的成立前提）。
//
// separator 用 `--`：科目目录名（builtin 四 id / _shared / 未来 subj_<cuid2>）与
// pack 名内部只出现单连字符，双连字符无歧义；本模块只做正向拼名，从不反向解析。

export const SKILL_NAMESPACE_SEPARATOR = '--';

export function namespacedSkillName(subjectDir: string, skillDirName: string): string {
  return `${subjectDir}${SKILL_NAMESPACE_SEPARATOR}${skillDirName}`;
}

/**
 * 把 SKILL.md frontmatter 的 `name: <目录名>` 行改写为命名空间名。
 *
 * 锚点即校验：frontmatter 块内第一条 name 行的值必须逐字等于目录名——不等（漂移）、
 * 无 frontmatter、或块内无 name 行时返回 null，调用方告警且不落改写（静态 audit
 * 在构建期就把漂移打红，运行期 null 理论不可达）。只改 name 一行，其余内容原样。
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
    if (line.trim() === '---') return null; // frontmatter 关闭仍无 name 行
    const m = line.match(/^name:\s*(.+?)\s*$/);
    if (m) {
      if (m[1] !== dirName) return null;
      lines[i] = `name: ${namespaced}`;
      return lines.join('\n');
    }
  }
  return null;
}
