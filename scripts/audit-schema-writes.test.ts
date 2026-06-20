import { describe, expect, it } from 'vitest';
import {
  type WriteStatement,
  countWriteHits,
  extractMergedPrRefsFromGitLog,
  extractWriteStatements,
  parseSchema,
  todayIso,
  validateAllowlistHygiene,
} from './audit-schema-writes';

const OPTIONS = {
  today: '2026-05-23',
  mergedPrRefs: new Set<string>(),
  statusText: '',
};

describe('audit-schema allowlist hygiene', () => {
  it('rejects legacy string resolves_when on business entries', () => {
    const result = validateAllowlistHygiene(
      {
        'question.rubric_json': {
          reason: 'Sub 1 JudgeTask grading config; not yet written by ingestion',
          resolves_when: 'Sub 1 JudgeTask + question authoring path implemented',
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'question.rubric_json',
        code: 'invalid_resolves_when',
      }),
    ]);
    expect(result.allowlist).toEqual({});
  });

  it('does not require reason or resolves_when on _comment markers', () => {
    const result = validateAllowlistHygiene(
      {
        _comment: 'schema fields with no write path',
        _comment_phase1c1_lane_a: 'historical marker',
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([]);
    expect(result.allowlist).toEqual({});
  });

  it('rejects entries whose expected_by date has passed', () => {
    const result = validateAllowlistHygiene(
      {
        'answer.input_kind': {
          reason: 'Answer table currently unused; review submit will write',
          resolves_when: {
            kind: 'manual',
            ref: 'Phase 1c.2 review submit path implemented',
            expected_by: '2026-05-22',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'answer.input_kind',
        code: 'expired_expected_by',
      }),
    ]);
  });

  it('rejects entries whose expected_by date is beyond the 12 month hygiene window', () => {
    const result = validateAllowlistHygiene(
      {
        'answer.input_kind': {
          reason: 'Answer table currently unused; review submit will write',
          resolves_when: {
            kind: 'manual',
            ref: 'Phase 1c.2 review submit path implemented',
            expected_by: '2028-01-01',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'answer.input_kind',
        code: 'invalid_expected_by',
      }),
    ]);
  });

  it('formats today using the local calendar date instead of UTC', () => {
    expect(todayIso(new Date(2026, 4, 23, 0, 30))).toBe('2026-05-23');
  });

  it('extracts merged PR refs from squash-merge and merge-commit subjects', () => {
    const refs = extractMergedPrRefsFromGitLog(
      [
        'a2b119a docs(plan): YUK-38 fix codex review findings + Linear reorg (#107)',
        'abc1234 Merge pull request #104 from Yukoval-Dakia/yuk-38-track2',
        'def5678 chore: unrelated commit',
      ].join('\n'),
    );

    expect([...refs].sort()).toEqual(['104', '107']);
  });

  it('rejects pr entries whose ref is already merged into local history', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.title': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'pr',
            ref: '#107',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        mergedPrRefs: new Set(['107']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.title',
        code: 'merged_pr',
      }),
    ]);
  });

  it('rejects pr entries whose ref is not an anchored PR reference', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.title': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'pr',
            ref: 'Phase 1c.1 follow-up',
            expected_by: '2026-07-31',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.title',
        code: 'invalid_ref',
      }),
    ]);
  });

  it('rejects phase entries whose ref appears in a shipped status line', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.generated_by': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'phase',
            ref: 'Foundation closeout P0',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        statusText: [
          '## 1. Phase 路线图（Foundation → Product Track → Later，2026-05-19 重排）',
          '',
          '```',
          '✅  Foundation closeout P0    PR #91 已 ship',
          '```',
        ].join('\n'),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.generated_by',
        code: 'shipped_phase',
      }),
    ]);
  });

  it('does not treat quoted shipped-looking text as a shipped status line', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.generated_by': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'phase',
            ref: 'Foundation closeout P0',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        statusText:
          '> ✅  Foundation closeout P0 shipped is only quoted historical discussion, not status',
      },
    );

    expect(result.issues).toEqual([]);
  });

  it('does not match phase refs that only appear outside the phase status section', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.generated_by': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'phase',
            ref: 'CapabilityRegistry',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        statusText: [
          '## Notes',
          '✅  CapabilityRegistry shipped appears in an unrelated note',
          '',
          '## 1. Phase 路线图（Foundation → Product Track → Later，2026-05-19 重排）',
          '```',
          '🟡  CapabilityRegistry + 默认 registry          ✅ src/core/capability/registry.ts',
          '```',
        ].join('\n'),
      },
    );

    expect(result.issues).toEqual([]);
  });

  it('does not treat an in-progress status row as shipped because a child file is checked off', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.generated_by': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'phase',
            ref: 'CapabilityRegistry',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        statusText:
          '🟡  CapabilityRegistry + 默认 registry          ✅ src/core/capability/registry.ts',
      },
    );

    expect(result.issues).toEqual([]);
  });

  it('accepts manual entries that preserve the current legacy text as ref', () => {
    const result = validateAllowlistHygiene(
      {
        'memory_brief_note.scope_key': {
          reason:
            'Schema lands in the LearningRecord migration; scheduled Dreaming refresh writes the row in the next batch',
          resolves_when: {
            kind: 'manual',
            ref: 'memory_brief_refresh boss handler implemented',
            expected_by: '2026-07-31',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([]);
    expect(result.allowlist['memory_brief_note.scope_key']).toEqual({
      reason:
        'Schema lands in the LearningRecord migration; scheduled Dreaming refresh writes the row in the next batch',
      resolves_when: {
        kind: 'manual',
        ref: 'memory_brief_refresh boss handler implemented',
        expected_by: '2026-07-31',
      },
    });
  });
});

// YUK-385: parseSchema must recognise the project `vector()` customType so the
// pgvector embedding columns are audited instead of silently escaping parsing.
describe('parseSchema vector() customType (YUK-385)', () => {
  it('parses a vector() column as a field of type vector', () => {
    const src = `
export const knowledge = pgTable('knowledge', {
  id: text('id').primaryKey(),
  embedding: vector(1024),
});
`;
    const fields = parseSchema(src);
    expect(fields).toContainEqual({ table: 'knowledge', field: 'embedding', type: 'vector' });
  });

  it('still parses native column constructors alongside customTypes', () => {
    const src = `
export const question = pgTable('question', {
  id: text('id').primaryKey(),
  prompt_md: text('prompt_md').notNull(),
  embedding: vector(1024),
  difficulty: real('difficulty'),
});
`;
    const fields = parseSchema(src);
    const byField = Object.fromEntries(fields.map((f) => [f.field, f.type]));
    expect(byField.prompt_md).toBe('text');
    expect(byField.embedding).toBe('vector');
    expect(byField.difficulty).toBe('real');
  });

  it('does not emit schema constraint helpers as fields', () => {
    const src = `
export const knowledge_edge = pgTable('knowledge_edge', {
  id: text('id').primaryKey(),
  embedding: vector(1024),
  uq: unique('uq').on(),
});
`;
    const fields = parseSchema(src).map((f) => f.field);
    expect(fields).toContain('embedding');
    expect(fields).not.toContain('uq');
  });
});

// YUK-166: write-path matching must be table-aware so a same-named column on a
// different table no longer cross-satisfies the audit.
describe('extractWriteStatements table-scoping (YUK-166)', () => {
  it('scopes an insert to the table named in .insert(table)', () => {
    const src = `await db.insert(question).values({ parent_question_id: x, prompt_md: 'p' });`;
    expect(extractWriteStatements(src)).toEqual([
      { kind: 'insert', table: 'question', payload: "{ parent_question_id: x, prompt_md: 'p' }" },
    ]);
  });

  it('scopes an update to the table named in .update(table)', () => {
    const src = `await db.update(echo_jobs).set({ output, status: 'completed' }).where(eq(echo_jobs.id, id));`;
    const stmts = extractWriteStatements(src);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].kind).toBe('update');
    expect(stmts[0].table).toBe('echo_jobs');
    expect(stmts[0].payload).toContain('output');
    expect(stmts[0].payload).toContain('status');
  });

  it('extracts the first object of an array-form .values([...])', () => {
    const src = `await tx.insert(question).values([{ id: a, source: 'import' }, { id: b }]);`;
    const stmts = extractWriteStatements(src);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].table).toBe('question');
    expect(stmts[0].payload).toContain('source');
  });

  it('does not let braces inside strings break balance', () => {
    const src = `await db.insert(event).values({ payload: '{not a brace}', action: 'x' });`;
    const stmts = extractWriteStatements(src);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].payload).toContain('action');
  });
});

describe('countWriteHits table-awareness (YUK-166)', () => {
  // The regression: question.parent_question_id and mistake_variant.parent_question_id
  // share a column name. A write to mistake_variant must NOT count as a write to
  // question.parent_question_id (the pre-fix file-level matcher conflated them).
  const index = new Map<string, WriteStatement[]>([
    [
      'mistakes.ts',
      [{ kind: 'insert', table: 'mistake_variant', payload: '{ parent_question_id: rootId }' }],
    ],
    [
      'create-part.ts',
      [{ kind: 'insert', table: 'question', payload: '{ parent_question_id: rootId }' }],
    ],
  ]);

  it('counts a field only against its own table', () => {
    const q = countWriteHits('question', 'parent_question_id', index);
    expect(q.insert_files).toBe(1);

    const mv = countWriteHits('mistake_variant', 'parent_question_id', index);
    expect(mv.insert_files).toBe(1);
  });

  it('does NOT count a sibling-table write toward the queried table', () => {
    // If create-part.ts were absent, question.parent_question_id would have ZERO
    // hits even though mistake_variant writes the same column name.
    const onlyMistake = new Map<string, WriteStatement[]>([
      [
        'mistakes.ts',
        [{ kind: 'insert', table: 'mistake_variant', payload: '{ parent_question_id: rootId }' }],
      ],
    ]);
    const q = countWriteHits('question', 'parent_question_id', onlyMistake);
    expect(q.insert_files).toBe(0);
    expect(q.update_files).toBe(0);
  });

  it('separates insert-only from update-only paths per table', () => {
    const idx = new Map<string, WriteStatement[]>([
      ['handler.ts', [{ kind: 'update', table: 'echo_jobs', payload: '{ output, status }' }]],
    ]);
    const out = countWriteHits('echo_jobs', 'output', idx);
    expect(out.insert_files).toBe(0);
    expect(out.update_files).toBe(1);

    // input is never in the echo_jobs statement → no write path for that column.
    const input = countWriteHits('echo_jobs', 'input', idx);
    expect(input.insert_files).toBe(0);
    expect(input.update_files).toBe(0);
  });

  it('matches drizzle shorthand field references inside the payload', () => {
    const idx = new Map<string, WriteStatement[]>([
      [
        'x.ts',
        [{ kind: 'insert', table: 'cost_ledger', payload: '{ cost, currency, tokens_in }' }],
      ],
    ]);
    expect(countWriteHits('cost_ledger', 'cost', idx).insert_files).toBe(1);
    expect(countWriteHits('cost_ledger', 'currency', idx).insert_files).toBe(1);
  });
});
