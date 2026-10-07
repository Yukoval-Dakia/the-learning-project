import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAssertions } from '../src/server/release/assessment-manifest';
import {
  EXPECTED_GRADING_ENTRIES,
  collectAssessmentSourceEvidence,
  inspectAssessmentSources,
} from './lib/assessment-entrypoint-source';

const authority = 'src/capabilities/practice/server/judge/evaluation-authority.ts';
const context = {
  outstanding: [],
  epoch: { epoch: 'assessment-contract-v1', state: 'active', seq: 7 },
  migrationsApplied: 120,
  migrationFilesTotal: 120,
  seriesMigrationFiles: [],
  staleSubscriptionDeliveries: 0,
  pendingEvaluations: 0,
  expectedEpoch: 'assessment-contract-v1',
};
const assertion = (source: ReturnType<typeof inspectAssessmentSources>) =>
  buildAssertions(context, source).find((row) => row.id === 'no-runtime-fallback');

describe('assessment checkout source evidence', () => {
  it('reports actual current callers despite an active epoch', () => {
    const source = collectAssessmentSourceEvidence(process.cwd());
    expect(source.missingEntries).toEqual([]);
    expect(source.unresolved).toEqual([]);
    expect(source.calls.map((call) => call.entry).sort()).toEqual(
      [...EXPECTED_GRADING_ENTRIES].sort(),
    );
    expect(source.calls.every((call) => call.lane === 'contract')).toBe(true);
    expect(source.legacyExecutor).toHaveLength(0);
    expect(source.files.length).toBeGreaterThanOrEqual(9);
    expect(source.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(assertion(source)?.status).toBe('info');
  });

  it.each([
    [
      'missing evaluator edge',
      (source: string) => source.replace('await evaluateAttempt({', 'await unrelated({'),
    ],
    ['legacy bridge', (source: string) => source.replace('contract: {', 'legacy: {')],
    [
      'changed forwarded entry',
      (source: string) =>
        source.replace('    entry,\n    questionId,', "    'solo_submit',\n    questionId,"),
    ],
    [
      'reassigned parameter',
      (source: string) =>
        source.replace(
          '  const prepared = await previewFormalAttempt(',
          "  entry = 'solo_submit';\n  const prepared = await previewFormalAttempt(",
        ),
    ],
    [
      'spread evaluator input',
      (source: string) => source.replace('    contract: {', '    ...override,\n    contract: {'),
    ],
  ])('does not certify a broken shared bridge: %s', (_label, mutate) => {
    const bridge = 'src/capabilities/practice/server/assessment/attempt.ts';
    const source = inspectAssessmentSources({
      [authority]: readFileSync(authority, 'utf8'),
      [bridge]: mutate(readFileSync(bridge, 'utf8')),
      'src/caller.ts':
        "import {commitFormalAttempt} from '@/capabilities/practice/server/assessment/attempt'; commitFormalAttempt(db, 'solo_submit', id, request);",
    });
    expect(source.unresolved.length).toBeGreaterThan(0);
    expect(source.calls.some((call) => call.entry === 'solo_submit')).toBe(false);
    expect(assertion(source)?.status).not.toBe('ok');
  });

  it.each([
    [
      "import {commitFormalAttempt} from '@/capabilities/practice/server/assessment/attempt'; commitFormalAttempt(db, 'solo_submit', id, request);",
      true,
    ],
    [
      "import {commitFormalAttempt as commit} from '@/capabilities/practice/server/assessment/attempt'; commit(db, 'solo_submit', id, request);",
      true,
    ],
    ["commitFormalAttempt(db, 'solo_submit', id, request);", false],
    [
      "import {commitFormalAttempt} from './unrelated'; commitFormalAttempt(db, 'solo_submit', id, request);",
      false,
    ],
    [
      "import {commitFormalAttempt} from '@/capabilities/practice/server/assessment/attempt'; function bad(commitFormalAttempt) { commitFormalAttempt(db, 'solo_submit', id, request); }",
      false,
    ],
    [
      "import {commitFormalAttempt} from '@/capabilities/practice/server/assessment/attempt'; const commit = commitFormalAttempt; commit(db, 'solo_submit', id, request);",
      false,
    ],
  ])('requires a bound wrapper import: %s', (caller, proven) => {
    const bridge = 'src/capabilities/practice/server/assessment/attempt.ts';
    const source = inspectAssessmentSources({
      [authority]: readFileSync(authority, 'utf8'),
      [bridge]: readFileSync(bridge, 'utf8'),
      'src/caller.ts': caller,
    });
    expect(source.calls.some((call) => call.entry === 'solo_submit')).toBe(proven);
    expect(source.unresolved.length === 0).toBe(proven);
  });

  it('ignores misleading registry labels, comments and string snippets', () => {
    const source = inspectAssessmentSources({
      [authority]: `export const registry = [{entry:'solo_submit', lane:'contract'}];
        // evaluateAttempt({entry:'solo_submit', contract: ref})
        const example = "evaluateAttempt({entry:'solo_submit', contract: ref})";
        export function evaluateAttempt(input) { return createDefaultJudgeInvoker().invoke(input.legacy); }`,
      'src/submit.ts': `import { evaluateAttempt as grade } from './judge';
        grade({ entry: opts.durable ? 'durable_judge_run' : 'solo_submit',
          legacy: { answer_md: '多行答案\\n证明过程与反例', student_image_refs: ['blob/one', 'blob/two'],
            ...(opts.durable ? {durable:opts.durable} : {}) } });`,
    });
    expect(source.calls.map((call) => [call.entry, call.lane])).toEqual([
      ['durable_judge_run', 'legacy'],
      ['solo_submit', 'legacy'],
    ]);
    expect(source.unresolved).toEqual([]);
    expect(assertion(source)?.status).toBe('fail');
  });

  it('collects namespace calls and quoted properties without importing runtime code', () => {
    const source = inspectAssessmentSources({
      [authority]: 'export function evaluateAttempt(input) { return evaluateSubmission(input); }',
      'src/paper.ts': `import * as judge from './judge';
        judge.evaluateAttempt(({ 'entry': 'paper_submit', 'contract': { submission_id:'frozen', evaluation_group_id:'group' } } as const));`,
    });
    expect(source.calls[0]).toMatchObject({
      entry: 'paper_submit',
      lane: 'contract',
      file: 'src/paper.ts',
      line: 2,
    });
    expect(source.unresolved).toEqual([]);
    expect(assertion(source)?.status).toBe('info');
  });

  it.each([
    `evaluateAttempt(input)`,
    `evaluateAttempt({ entry: chosen, legacy: input })`,
    `evaluateAttempt({ entry: 'solo_submit', contract: input, ...override })`,
    `evaluateAttempt({ entry: 'solo_submit', contract: input, legacy: input })`,
    `evaluateAttempt({ entry: 'solo_submit', contract: input, entry: 'paper_submit' })`,
    `const grade = evaluateAttempt; grade({entry:'solo_submit',contract:input})`,
    `judge['evaluateAttempt']({entry:'solo_submit',contract:input})`,
    `evaluateAttempt({ entry: 'unregistered', contract: input })`,
  ])('keeps unsupported or ambiguous input visible: %s', (text) => {
    const source = inspectAssessmentSources({ [authority]: '', 'src/caller.ts': text });
    expect(source.unresolved.length).toBeGreaterThan(0);
    expect(assertion(source)?.status).not.toBe('ok');
  });

  it('does not infer deployed runtime success from complete contract call-site syntax', () => {
    const source = inspectAssessmentSources({
      [authority]: 'export function evaluateAttempt(input) { return evaluateSubmission(input); }',
      'src/callers.ts': EXPECTED_GRADING_ENTRIES.map(
        (entry) =>
          `evaluateAttempt({entry:'${entry}',contract:{submission_id:'s',evaluation_group_id:'g'}});`,
      ).join('\n'),
    });
    expect(source.missingEntries).toEqual([]);
    expect(source.unresolved).toEqual([]);
    expect(assertion(source)).toMatchObject({
      status: 'info',
      detail: expect.stringContaining('部署镜像身份/运行时迁移未核验'),
    });
  });

  it('retains executor failure even when all caller syntax is contract', () => {
    const source = inspectAssessmentSources({
      [authority]: `import { createDefaultJudgeInvoker as makeJudge } from './invoker';
        export function evaluateAttempt(input) { return makeJudge().invoke(input.legacy); }`,
      'src/callers.ts': EXPECTED_GRADING_ENTRIES.map(
        (entry) => `evaluateAttempt({entry:'${entry}',contract:input});`,
      ).join('\n'),
    });
    expect(source.legacyExecutor).toHaveLength(1);
    expect(assertion(source)?.status).toBe('fail');
  });

  it('empty or incomplete checkout never passes and hashes change with source content', () => {
    const empty = inspectAssessmentSources({});
    expect(empty.missingEntries).toHaveLength(8);
    expect(empty.unresolved).toHaveLength(1);
    expect(assertion(empty)?.status).toBe('info');
    const a = inspectAssessmentSources({ [authority]: 'export const a = 1;' });
    const b = inspectAssessmentSources({ [authority]: 'export const a = 2;' });
    expect(a.files[0].sha256).not.toBe(b.files[0].sha256);
  });
});
