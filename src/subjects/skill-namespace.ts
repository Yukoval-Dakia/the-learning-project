// YUK-611 — skill 命名空间单一权威模块。
//
// Skill resolver（quiz-gen / note / copilot）直接读 src/subjects/<dir>/skills/*
// 的 SKILL.md 正文交给 pi adapter 注入 system prompt；注入键统一命名空间化
// `<subjectDir>--<pack>`（本模块拼名），`_shared` 伪目录同规则
// （`_shared--copilot`）。目录 basename 曾是全局键：跨科同名目录会产出语义
// 重名的注入块——今日三科不撞是巧合不是约束（note-* 自发带科目后缀，
// quiz-gen-* 没有）。
//
// 防线（YUK-597 v3 契约 §5.2 ②）：构建期静态 audit（skill-namespace.test.ts）
// 挡跨科 basename 重复 + frontmatter name 必须 == 目录名（rewriteSkillMdName
// 的锚点——它如今只作该不变量的判定器）。
//
// separator 用 `--`：科目目录名（builtin 四 id / _shared / 未来 subj_<cuid2>）与
// pack 名内部只出现单连字符，双连字符无歧义；本模块只做正向拼名，从不反向解析。

export const SKILL_NAMESPACE_SEPARATOR = '--';

export function namespacedSkillName(subjectDir: string, skillDirName: string): string {
  return `${subjectDir}${SKILL_NAMESPACE_SEPARATOR}${skillDirName}`;
}

/**
 * Frontmatter-name 漂移判定器（YUK-611 audit 锚点）。
 *
 * Post-YUK-1025 无 live 改写消费方：静态 audit（skill-namespace.test.ts）调用它
 * 校验「frontmatter 块内第一条 name 行的值逐字等于目录名」——不等（漂移）、
 * 无 frontmatter、或块内无 name 行时返回 null = 该包漂移打红。返回值为改写后
 * 文档，仅测试断言用。
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
