// YUK-611 — skill 命名空间：helper unit + 构建期静态撞名 audit。
//
// audit 半边（v3 契约 §5.2 ②）：枚举真实 src/subjects/*/skills/* ——
//   1. 跨科 basename 重复即红（镜像前缀化后互踩通道已关，此处是防线的静态半：
//      防前缀化被绕过/回退，也防 docs/工具按裸名引用时的歧义）；
//   2. 每个 SKILL.md 的 frontmatter name 必须 == 目录 basename——这是 populate
//      改写锚点（rewriteSkillMdName）的成立前提，漂移 = 该包白名单静默 miss。
// 纯 fs 扫描零 DB —— unit 分区；MUST be listed in fastTestInclude。

import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { namespacedSkillName, rewriteSkillMdName } from './skill-namespace';

describe('namespacedSkillName', () => {
  it('拼 <subjectDir>--<pack>', () => {
    expect(namespacedSkillName('yuwen', 'quiz-gen-translation')).toBe(
      'yuwen--quiz-gen-translation',
    );
    expect(namespacedSkillName('_shared', 'copilot')).toBe('_shared--copilot');
  });
});

describe('rewriteSkillMdName', () => {
  const doc = (name: string) => `---\nname: ${name}\ndescription: 说明文字\n---\n正文 body\n`;

  it('改写 frontmatter name 行为命名空间名，其余逐字保留', () => {
    const out = rewriteSkillMdName(doc('copilot'), 'copilot', '_shared--copilot');
    expect(out).toBe('---\nname: _shared--copilot\ndescription: 说明文字\n---\n正文 body\n');
  });

  it('容忍 name 行值两侧空白', () => {
    const out = rewriteSkillMdName(
      '---\nname:   copilot  \n---\nbody\n',
      'copilot',
      '_shared--copilot',
    );
    expect(out).toBe('---\nname: _shared--copilot\n---\nbody\n');
  });

  it('漂移（name != 目录名）→ null', () => {
    expect(rewriteSkillMdName(doc('something-else'), 'copilot', '_shared--copilot')).toBeNull();
  });

  it('无 frontmatter → null', () => {
    expect(rewriteSkillMdName('just body\n', 'copilot', '_shared--copilot')).toBeNull();
  });

  it('frontmatter 关闭仍无 name 行 → null', () => {
    expect(
      rewriteSkillMdName('---\ndescription: d\n---\nbody\n', 'copilot', '_shared--copilot'),
    ).toBeNull();
  });
});

describe('静态撞名 audit — 真实 src/subjects 树 (YUK-611)', () => {
  const SUBJECTS_DIR = join(process.cwd(), 'src', 'subjects');

  function listSkillDirs(
    subjectsRoot: string = SUBJECTS_DIR,
  ): Array<{ subject: string; pack: string; dir: string }> {
    const out: Array<{ subject: string; pack: string; dir: string }> = [];
    for (const subject of readdirSync(subjectsRoot, { withFileTypes: true })) {
      if (!subject.isDirectory()) continue;
      const skillsDir = join(subjectsRoot, subject.name, 'skills');
      let packs: string[];
      try {
        packs = readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue; // 该科无 skills 树
      }
      for (const pack of packs) {
        out.push({ subject: subject.name, pack, dir: join(skillsDir, pack) });
      }
    }
    return out;
  }

  function findDuplicatePacks(
    dirs: Array<{ subject: string; pack: string }>,
  ): Array<[string, string[]]> {
    const byPack = new Map<string, string[]>();
    for (const { subject, pack } of dirs) {
      byPack.set(pack, [...(byPack.get(pack) ?? []), subject]);
    }
    return [...byPack.entries()].filter(([, subjects]) => subjects.length > 1);
  }

  it('检测器对撞名 fixture 必红（验收反例：两科同名 skill 目录）', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillns-audit-'));
    for (const subject of ['yuwen', 'math']) {
      mkdirSync(join(root, subject, 'skills', 'quiz-gen-calculation'), { recursive: true });
    }
    const duplicates = findDuplicatePacks(listSkillDirs(root));
    expect(duplicates).toEqual([['quiz-gen-calculation', ['math', 'yuwen']]]);
  });

  it('跨科 skill 目录 basename 零重复（撞名没有合法理由，无 allowlist）', () => {
    const dirs = listSkillDirs();
    expect(dirs.length).toBeGreaterThan(0); // 扫描跑空 = 断言失效，显式翻红
    expect(findDuplicatePacks(dirs)).toEqual([]);
  });

  it('每个 SKILL.md 的 frontmatter name == 目录 basename（populate 改写锚点前提）', () => {
    const drifted: string[] = [];
    for (const { subject, pack, dir } of listSkillDirs()) {
      let content: string;
      try {
        content = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      } catch {
        continue; // 无 SKILL.md 的目录 SDK 忽略，不在锚点合同内
      }
      // 与 rewriteSkillMdName 同锚点：改写在真树上必须可用（null = 漂移）。
      if (rewriteSkillMdName(content, pack, namespacedSkillName(subject, pack)) === null) {
        drifted.push(`${subject}/skills/${pack}`);
      }
    }
    expect(drifted).toEqual([]);
  });
});
