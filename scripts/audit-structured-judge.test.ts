import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from '@/ai/registry';
import { describe, expect, it } from 'vitest';
import {
  type Allowlist,
  type TaskDefLike,
  collectJudgeTasks,
  computeStructuredJudgeAudit,
  validateAllowlistEntry,
} from './audit-structured-judge';

// YUK-591 §7 — self-test for the structured-judge audit. Pins:
//   (1) collectJudgeTasks picks kinds ending in `JudgeTask` + reads the schema flag.
//   (2) validateAllowlistEntry enforces the reason + resolves_when contract.
//   (3) computeStructuredJudgeAudit: missing-schema-not-allowlisted → violation;
//       allowlisted → ok; dead allowlist key → redundant.
//   (4) the REAL registry + shipped allowlist pass (regression guard), and the
//       current judge-task set is exactly the three known kinds (a rename that
//       drops the suffix, or a new judge task, surfaces here in review).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUTURE = '2099-01-01';

function reg(defs: Record<string, TaskDefLike>): Record<string, TaskDefLike> {
  return defs;
}

describe('collectJudgeTasks', () => {
  it('selects only kinds ending in JudgeTask, sorted, with the schema flag', () => {
    const result = collectJudgeTasks(
      reg({
        FooJudgeTask: { structuredOutputSchema: {} },
        BarJudgeTask: {},
        NotAJudge: { structuredOutputSchema: {} },
        VariantVerifyTask: {},
      }),
    );
    expect(result).toEqual([
      { kind: 'BarJudgeTask', hasStructuredOutput: false },
      { kind: 'FooJudgeTask', hasStructuredOutput: true },
    ]);
  });
});

describe('validateAllowlistEntry', () => {
  it('accepts a well-formed entry', () => {
    const problems = validateAllowlistEntry(
      'X',
      { reason: 'because', resolves_when: { kind: 'manual', ref: 'YUK-1', expected_by: FUTURE } },
      '2026-07-23',
    );
    expect(problems).toEqual([]);
  });

  it('rejects an empty reason', () => {
    const problems = validateAllowlistEntry(
      'X',
      { reason: '  ', resolves_when: { kind: 'pr', ref: '#9', expected_by: FUTURE } },
      '2026-07-23',
    );
    expect(problems.map((p) => p.detail)).toContain('reason must be a non-empty string');
  });

  it('rejects a bad resolves_when.kind and a past expected_by', () => {
    const problems = validateAllowlistEntry(
      'X',
      {
        reason: 'r',
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for the test
        resolves_when: { kind: 'whenever' as any, ref: 'YUK-1', expected_by: '2000-01-01' },
      },
      '2026-07-23',
    );
    const details = problems.map((p) => p.detail);
    expect(details.some((d) => d.includes("must be 'pr', 'phase', or 'manual'"))).toBe(true);
    expect(details.some((d) => d.includes('is before 2026-07-23'))).toBe(true);
  });
});

describe('computeStructuredJudgeAudit', () => {
  const today = '2026-07-23';

  it('flags a missing-schema judge task that is not allowlisted', () => {
    const result = computeStructuredJudgeAudit(
      [{ kind: 'BarJudgeTask', hasStructuredOutput: false }],
      {},
      today,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(['BarJudgeTask']);
  });

  it('passes a missing-schema judge task that is allowlisted with a valid entry', () => {
    const allowlist: Allowlist = {
      BarJudgeTask: {
        reason: 'tracked follow-up',
        resolves_when: { kind: 'manual', ref: 'YUK-1', expected_by: FUTURE },
      },
    };
    const result = computeStructuredJudgeAudit(
      [
        { kind: 'FooJudgeTask', hasStructuredOutput: true },
        { kind: 'BarJudgeTask', hasStructuredOutput: false },
      ],
      allowlist,
      today,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.allowlisted).toEqual(['BarJudgeTask']);
  });

  it('reports a dead allowlist key (no matching missing-schema judge task) as redundant', () => {
    const allowlist: Allowlist = {
      // FooJudgeTask HAS a schema now → its allowlist entry is dead config.
      FooJudgeTask: {
        reason: 'stale',
        resolves_when: { kind: 'manual', ref: 'YUK-1', expected_by: FUTURE },
      },
    };
    const result = computeStructuredJudgeAudit(
      [{ kind: 'FooJudgeTask', hasStructuredOutput: true }],
      allowlist,
      today,
    );
    expect(result.ok).toBe(false);
    expect(result.redundantAllowlist).toEqual(['FooJudgeTask']);
  });
});

describe('real registry + shipped allowlist', () => {
  const shippedAllowlist = JSON.parse(
    readFileSync(join(__dirname, 'audit-structured-judge-allowlist.json'), 'utf-8'),
  ) as Allowlist;

  it('has exactly the three known judge tasks with the expected schema state', () => {
    const judgeTasks = collectJudgeTasks(tasks as Record<string, TaskDefLike>);
    expect(judgeTasks).toEqual([
      { kind: 'MultimodalDirectJudgeTask', hasStructuredOutput: true },
      { kind: 'SemanticJudgeTask', hasStructuredOutput: false },
      { kind: 'StepsJudgeTask', hasStructuredOutput: true },
    ]);
  });

  it('passes the audit as shipped (violations + redundant + allowlist problems all clear)', () => {
    const judgeTasks = collectJudgeTasks(tasks as Record<string, TaskDefLike>);
    // A fixed `today` well before every shipped expected_by keeps this a state
    // regression guard, not a clock-dependent test.
    const result = computeStructuredJudgeAudit(judgeTasks, shippedAllowlist, '2026-07-23');
    expect(result.violations).toEqual([]);
    expect(result.redundantAllowlist).toEqual([]);
    expect(result.allowlistProblems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
