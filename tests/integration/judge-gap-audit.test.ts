import fs from 'node:fs/promises';
import path from 'node:path';

import { getDefaultRegistry } from '@/core/capability/judges';
import { FUTURE_JUDGE_ROUTES, RUNNABLE_ROUTES } from '@/server/ai/judges/question-contract';
import { subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

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
      if (rel === 'src/server/ai/judges/question-contract.ts') continue;
      const text = await fs.readFile(file, 'utf8');
      if (/preferredRoutes\s*\.\s*(find|includes|filter)/.test(text)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `Judge route selection must go through src/server/ai/judges/question-contract.ts:\n${offenders.join(
        '\n',
      )}`,
    ).toEqual([]);
  });
});
