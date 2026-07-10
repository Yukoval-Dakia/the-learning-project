// YUK-611 — populateIsolatedSkills 镜像命名空间化 unit。
//
// 纯 fs（mkdtemp fixture 树 + mkdtemp isolatedDir），零 DB 零 SDK——模块从
// runner.ts 摘出正为此可测。断言的合同：镜像目录名 = <subjectDir>--<pack>、
// 镜像内 SKILL.md frontmatter name 同步改写、其余内容逐字保真、跨科同名目录
// 互不侵吞、漂移/缺文件/缺树全部 never-throws 降级。
// NOTE: this file MUST be listed in fastTestInclude (vitest.shared.ts) — the unit
// partition is an explicit allowlist, not an import sniff.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { populateIsolatedSkills } from './populate-skills';

// layout: { <subjectDir>: { <skillDir>: <SKILL.md content | null（不写 SKILL.md）> } }
function fixtureSubjects(layout: Record<string, Record<string, string | null>>): string {
  const root = mkdtempSync(join(tmpdir(), 'popskills-src-'));
  for (const [subjectDir, packs] of Object.entries(layout)) {
    for (const [skillDir, skillMd] of Object.entries(packs)) {
      const dir = join(root, subjectDir, 'skills', skillDir);
      mkdirSync(dir, { recursive: true });
      if (skillMd !== null) writeFileSync(join(dir, 'SKILL.md'), skillMd);
    }
  }
  return root;
}

function isolated(): string {
  return mkdtempSync(join(tmpdir(), 'popskills-dest-'));
}

const md = (name: string, body: string) => `---\nname: ${name}\ndescription: d\n---\n${body}\n`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('populateIsolatedSkills — 命名空间镜像 (YUK-611)', () => {
  it('跨科同名目录互不侵吞：各得 <subject>--<pack>，内容各自保真', () => {
    const root = fixtureSubjects({
      yuwen: { 'quiz-gen-calculation': md('quiz-gen-calculation', 'yuwen body') },
      math: { 'quiz-gen-calculation': md('quiz-gen-calculation', 'math body') },
    });
    const dest = isolated();
    populateIsolatedSkills(dest, root);

    const yuwenMd = readFileSync(
      join(dest, 'skills', 'yuwen--quiz-gen-calculation', 'SKILL.md'),
      'utf8',
    );
    const mathMd = readFileSync(
      join(dest, 'skills', 'math--quiz-gen-calculation', 'SKILL.md'),
      'utf8',
    );
    expect(yuwenMd).toContain('yuwen body');
    expect(mathMd).toContain('math body');
    // 旧扁平裸名不再产生（互踩通道关闭）。
    expect(existsSync(join(dest, 'skills', 'quiz-gen-calculation'))).toBe(false);
  });

  it('镜像内 frontmatter name 改写为命名空间名，其余内容逐字保留', () => {
    const root = fixtureSubjects({
      _shared: { copilot: md('copilot', 'methodology body') },
    });
    const dest = isolated();
    populateIsolatedSkills(dest, root);

    const mirrored = readFileSync(join(dest, 'skills', '_shared--copilot', 'SKILL.md'), 'utf8');
    expect(mirrored).toMatch(/^name: _shared--copilot$/m);
    expect(mirrored).not.toMatch(/^name: copilot$/m);
    expect(mirrored).toContain('description: d');
    expect(mirrored).toContain('methodology body');
  });

  it('references/assets 子树随包镜像', () => {
    const root = fixtureSubjects({
      yuwen: { 'quiz-gen-translation': md('quiz-gen-translation', 'b') },
    });
    const refDir = join(root, 'yuwen', 'skills', 'quiz-gen-translation', 'references');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'rubric.md'), 'ref content');
    const dest = isolated();
    populateIsolatedSkills(dest, root);

    expect(
      readFileSync(
        join(dest, 'skills', 'yuwen--quiz-gen-translation', 'references', 'rubric.md'),
        'utf8',
      ),
    ).toBe('ref content');
  });

  it('frontmatter 漂移（name != 目录名）→ console.error + 镜像保持原内容不改写', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drifted = md('some-other-name', 'body');
    const root = fixtureSubjects({ yuwen: { 'quiz-gen-translation': drifted } });
    const dest = isolated();
    populateIsolatedSkills(dest, root);

    const mirrored = readFileSync(
      join(dest, 'skills', 'yuwen--quiz-gen-translation', 'SKILL.md'),
      'utf8',
    );
    expect(mirrored).toBe(drifted); // 原样镜像，不落半改写
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('frontmatter name != directory name'),
      expect.objectContaining({ skill: 'quiz-gen-translation', subject: 'yuwen' }),
    );
  });

  it('无 SKILL.md 的目录照常镜像、不 throw、无告警', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = fixtureSubjects({ yuwen: { 'half-authored': null } });
    const dest = isolated();
    populateIsolatedSkills(dest, root);

    expect(existsSync(join(dest, 'skills', 'yuwen--half-authored'))).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('subjectsRoot 路径不存在 → 整体 no-op，never throws', () => {
    // 注：显式传 undefined 会按 JS 默认参数语义落回生产探测（cwd//app），
    // 表达不了「无根」；「无根」在这里等价于给一条不存在的路径（readdir 抛
    // ENOENT → 吞掉 → 早退）。
    const dest = isolated();
    expect(() =>
      populateIsolatedSkills(dest, join(tmpdir(), 'popskills-definitely-missing')),
    ).not.toThrow();
    expect(existsSync(join(dest, 'skills'))).toBe(false);
  });
});
