// YUK-573 (leg B) — prompt-render snapshot gate: the rendered system prompts of
// the three judge tasks × every registry profile must match their committed
// snapshots (scripts/judge-golden/prompts/*.md). A prompt edit therefore fails
// this gate until the author re-runs `pnpm audit:judge-prompts --write` — which
// turns the change into a reviewable snapshot diff in the PR. Pure + offline
// (getTaskSystemPrompt is a pure function; zero IO beyond reading snapshots).
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { subjectProfiles } from '@/subjects/profile';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JUDGE_PROMPT_TASKS,
  PROMPTS_DIR,
  reauditJudgePrompts,
  renderAllJudgePrompts,
} from './judge-prompt-reaudit';

describe('judge-prompt reaudit (leg B)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('committed snapshots cover 3 judge kinds × every registry profile and are CLEAN', () => {
    const result = reauditJudgePrompts();
    expect(result.checked).toBe(JUDGE_PROMPT_TASKS.length * Object.keys(subjectProfiles).length);
    expect(result.drifted).toEqual([]);
  });

  it('a tampered snapshot surfaces as content drift', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'judge-prompts-'));
    tmpDirs.push(tmp);
    cpSync(PROMPTS_DIR, tmp, { recursive: true });
    const first = readdirSync(tmp).find((f) => f.endsWith('.md'));
    expect(first).toBeDefined();
    writeFileSync(join(tmp, first as string), '被篡改的 snapshot 内容\n');
    const result = reauditJudgePrompts(tmp);
    expect(result.drifted.length).toBeGreaterThan(0);
    expect(result.drifted.join(' | ')).toContain(first as string);
  });

  it('a stale extra snapshot surfaces as drift', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'judge-prompts-'));
    tmpDirs.push(tmp);
    cpSync(PROMPTS_DIR, tmp, { recursive: true });
    writeFileSync(join(tmp, 'RetiredJudgeTask.wenyan.md'), '孤儿 snapshot\n');
    const result = reauditJudgePrompts(tmp);
    expect(result.drifted.join(' | ')).toContain('RetiredJudgeTask.wenyan.md');
  });

  it('prompt rendering is deterministic', () => {
    const a = renderAllJudgePrompts();
    const b = renderAllJudgePrompts();
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
    expect(a.size).toBeGreaterThan(0);
  });
});
