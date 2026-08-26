import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FUTURE_JUDGE_ROUTES,
  RUNNABLE_ROUTES,
  resolveQuestionJudgeRoute,
} from '@/capabilities/practice/server/judge/question-contract';
import { getDefaultRegistry } from '@/core/capability/judges';
import { ANSWER_CLASSES, deriveAnswerClass } from '@/core/schema/answer-class';
import { QuestionKind } from '@/core/schema/business';
import { subjectProfiles } from '@/subjects/profile';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_ROOTS = ['app', 'src/server', 'src/core', 'src/subjects'] as const;
const SCAN_EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build']);

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  await recurse(root);
  return out;
}

describe('Judge v2 light gap-prevention audit', () => {
  // YUK-391 (kind Step 4) — 「每 answer-class × profile 都有 verifier」: judge
  // routing converged onto the answer-class axis, so the gap-prevention contract is
  // stated per answer-class: across the FULL structural matrix (every canonical
  // kind × with/without choices × with/without rubric keywords), every route the
  // resolver picks under every profile must (a) be runnable by the invoker and
  // (b) have a registered judge capability, and every (profile × answer-class)
  // pairing must actually be served by at least one such route — a class with no
  // verifier under a profile is a silent grading gap.
  it('every answer-class × profile resolves to routes that all have a live verifier', () => {
    const registry = getDefaultRegistry();
    const runnable = RUNNABLE_ROUTES;
    const served = new Map<string, Set<string>>();
    const note = (profileId: string, cls: string, route: string): void => {
      const key = `${profileId}|${cls}`;
      const routes = served.get(key) ?? new Set<string>();
      routes.add(route);
      served.set(key, routes);
    };

    for (const profile of Object.values(subjectProfiles)) {
      for (const kind of QuestionKind.options) {
        for (const withChoices of [false, true]) {
          for (const withKw of [false, true]) {
            const rubric = withKw ? { criteria: [], keywords: ['x'] } : null;
            const choices = withChoices ? ['甲', '乙'] : null;
            const cell = `${profile.id}|${kind}|${withChoices ? 'c' : '-'}|${withKw ? 'k' : '-'}`;
            const route = resolveQuestionJudgeRoute(
              {
                id: `q-${cell}`,
                kind,
                rubric_json: rubric,
                choices_md: choices,
                judge_kind_override: null,
              },
              profile,
            );
            expect(runnable.has(route), `${cell}: route '${route}' not runnable`).toBe(true);
            expect(registry.hasJudge(route), `${cell}: route '${route}' has no judge`).toBe(true);
            note(
              profile.id,
              deriveAnswerClass({ kind, rubric_json: rubric, choices_md: choices }),
              route,
            );
          }
        }
      }
    }

    for (const profile of Object.values(subjectProfiles)) {
      for (const cls of ANSWER_CLASSES) {
        expect(
          served.get(`${profile.id}|${cls}`),
          `${profile.id}: answer-class '${cls}' has no verifier route`,
        ).toBeDefined();
      }
    }
  });

  it('subject judgeCapabilities resolve and future preferredRoutes are explicitly allowlisted', () => {
    const registry = getDefaultRegistry();
    // M2.2 (2026-05-22): use canonical RUNNABLE_ROUTES export — adding routes
    // (e.g. 'steps') no longer requires updating this audit's hardcoded set.
    const runnable = RUNNABLE_ROUTES;
    for (const profile of Object.values(subjectProfiles)) {
      for (const capability of profile.judgeCapabilities) {
        expect(
          registry.hasJudge(capability),
          `${profile.id}.judgeCapabilities contains unregistered '${capability}'`,
        ).toBe(true);
      }
      for (const route of profile.judgePolicy.preferredRoutes) {
        if (runnable.has(route)) continue;
        expect(
          Object.keys(FUTURE_JUDGE_ROUTES),
          `${profile.id}.preferredRoutes contains future route '${route}' without status`,
        ).toContain(route);
      }
    }
  });

  it('runtime code does not hand-pick preferredRoutes outside question-contract', async () => {
    const files = (
      await Promise.all(RUNTIME_ROOTS.map((root) => walkFiles(path.join(REPO_ROOT, root))))
    ).flat();
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (rel === 'src/capabilities/practice/server/judge/question-contract.ts') continue;
      // YUK-215 (PR #309 F0): resolveQuestionJudgeRoute 本体提取到无重依赖 leaf，
      // 打破 judges-barrel 与 client chunk 的 webpack 模块环（route 顶层 import
      // barrel 会毒化共享 chunk 致 prerender 崩溃）。question-contract 仍 re-export，
      // 路由选择的唯一语义入口不变——leaf 是它的物理宿主，同属 canonical。
      if (rel === 'src/capabilities/practice/server/judge/route-resolve.ts') continue;
      // 并行测试竞态容忍（YUK-222 gate 实测）：serialize round-trip 等测试会在
      // src/subjects/ 下创建临时 fixture 目录，walk 时存在、read 时已删 → ENOENT。
      // 消失的文件不可能是 offender，跳过即可；其它错误照常抛。
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (/preferredRoutes\s*\.\s*(find|includes|filter)/.test(text)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `Judge route selection must go through src/capabilities/practice/server/judge/question-contract.ts:\n${offenders.join(
        '\n',
      )}`,
    ).toEqual([]);
  });
});
