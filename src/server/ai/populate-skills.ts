// Isolated CLAUDE_CONFIG_DIR skills 镜像（YUK-611 时自 runner.ts 摘出成 fs-only
// 独立模块——unit 可测、零 SDK import；runner 的 getIsolatedClaudeConfigDir 是唯一
// 生产调用方）。
//
// Mirror every src/subjects/<dir>/skills/<skill>/ into <isolatedDir>/skills/.
// Best-effort + idempotent: a missing subjects tree (e.g. an unusual cwd) just
// yields no skills, and the runner degrades to promptFragments — never throws.
//
// YUK-611 — 镜像目录名 + 镜像内 SKILL.md `name` frontmatter 统一命名空间化
// `<subjectDir>--<pack>`（源树保持裸名）：flatten 后跨科同名目录不再静默互踩，
// resolver 白名单（quiz-gen / note / copilot 三家，均经 skill-namespace.ts 拼名）
// 与镜像键永远同源。frontmatter 漂移（name != 目录名——静态 audit
// skill-namespace.test.ts 已在构建期打红）→ 镜像目录仍命名空间化、仅 frontmatter
// 不改写 + console.error，不 throw：漂移包白名单必然 miss，宁可单包缺席也不让
// 整个镜像失败（目录已前缀化，也不会与他科同名包互踩）。

import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { namespacedSkillName, rewriteSkillMdName } from '@/subjects/skill-namespace';

// Resolve the on-disk src/subjects root across deploy layouts. In dev/test cwd is the
// repo root, so <cwd>/src/subjects exists. In the standalone production image the
// worker (`node worker.cjs`) / app (`node server.cjs`) run with cwd=/app, and the
// Dockerfile copies the skills subtrees to /app/src/subjects (PR #319 F2; coverage
// asserted by skills-image-coverage.test.ts, YUK-610). First existing candidate wins;
// none existing → undefined → no skills (degrade to promptFragments).
function resolveSubjectsRoot(): string | undefined {
  const candidates = [
    join(process.cwd(), 'src', 'subjects'),
    // standalone server.js/worker.cjs live at /app; src/subjects is a sibling.
    join('/app', 'src', 'subjects'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function populateIsolatedSkills(
  isolatedDir: string,
  // test seam：fixture 树注入；生产走默认 cwd//app 探测（与旧 runner 行为逐位一致）。
  subjectsRoot: string | undefined = resolveSubjectsRoot(),
): void {
  if (!subjectsRoot) return;
  const skillsDest = join(isolatedDir, 'skills');
  let subjectIds: string[];
  try {
    subjectIds = readdirSync(subjectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const subjectId of subjectIds) {
    const subjectSkillsDir = join(subjectsRoot, subjectId, 'skills');
    if (!existsSync(subjectSkillsDir)) continue;
    let skillNames: string[];
    try {
      skillNames = readdirSync(subjectSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const skillName of skillNames) {
      const src = join(subjectSkillsDir, skillName);
      // YUK-611: flatten 目标目录名加科目前缀——跨科同名目录各得其所，拷贝顺序
      // 不再决定谁活。
      const namespaced = namespacedSkillName(subjectId, skillName);
      const dest = join(skillsDest, namespaced);
      try {
        cpSync(src, dest, { recursive: true });
      } catch (err) {
        console.error('[runner] failed to populate skill into isolated config dir', {
          skill: skillName,
          subject: subjectId,
          err,
        });
        continue;
      }
      // SDK 按镜像内 SKILL.md 的 `name` frontmatter 匹配 Options.skills——与镜像
      // 目录名同步改写，白名单键三方同源（目录名 / frontmatter / resolver 拼名）。
      const skillMd = join(dest, 'SKILL.md');
      if (!existsSync(skillMd)) continue; // 无 SKILL.md 的目录 SDK 本就忽略
      try {
        const rewritten = rewriteSkillMdName(readFileSync(skillMd, 'utf8'), skillName, namespaced);
        if (rewritten === null) {
          console.error(
            '[runner] SKILL.md frontmatter name != directory name; frontmatter NOT rewritten (mirror dir is still namespaced) — pack will NOT match its whitelist key',
            { skill: skillName, subject: subjectId },
          );
          continue;
        }
        writeFileSync(skillMd, rewritten);
      } catch (err) {
        console.error('[runner] failed to namespace mirrored SKILL.md', {
          skill: skillName,
          subject: subjectId,
          err,
        });
      }
    }
  }
}
