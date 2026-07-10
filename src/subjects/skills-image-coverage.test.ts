// YUK-610 — Dockerfile 运行时镜像必须携带每个 on-disk skill 包。
//
// populateIsolatedSkills 在运行时对 src/subjects/<dir>/skills 做 readdirSync
// （不经 import，不进 bundle），所以 tsc/esbuild/vitest 常规车道都看不见
// 「目录存在于仓库、缺席于镜像」这类漏拷；且 resolver 的降级链设计是
// 「缺目录 → 不传 skills → 散文/promptFragments 兜底」——漏拷在生产是
// 静默降级，零报错零日志。2026-07-10 实况：_shared/skills（copilot +
// quiz-gen 共享包）漏拷，copilot 会话/copilot_run 的共享规范包在生产
// 缺席多日无人知晓。本断言是唯一的构建期防线：凡 src/subjects/<dir>/skills
// 树内存在 SKILL.md，Dockerfile 必须有对应 COPY 行。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SUBJECTS_DIR = join(ROOT, 'src', 'subjects');

function treeHasSkillMd(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'SKILL.md') return true;
    if (entry.isDirectory() && treeHasSkillMd(join(dir, entry.name))) return true;
  }
  return false;
}

describe('YUK-610 — Dockerfile skills COPY 覆盖', () => {
  it('src/subjects/<dir>/skills 含 SKILL.md 的每棵树都有对应 COPY 行', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const skillRoots = readdirSync(SUBJECTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        const skillsDir = join(SUBJECTS_DIR, name, 'skills');
        return existsSync(skillsDir) && treeHasSkillMd(skillsDir);
      });

    // 防守：扫描跑空说明布局变了（或 cwd 不是仓库根），断言本身失效——显式翻红。
    expect(skillRoots.length).toBeGreaterThan(0);

    // 匹配「源路径 目标路径」对而非整行 flag 形状，COPY 换 flag 不误伤。
    const missing = skillRoots.filter(
      (name) =>
        !dockerfile.includes(`/app/src/subjects/${name}/skills ./src/subjects/${name}/skills`),
    );
    expect(missing).toEqual([]);
  });
});
