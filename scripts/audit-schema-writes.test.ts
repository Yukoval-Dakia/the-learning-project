// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Source fixtures intentionally contain unevaluated SQL template expressions.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type WriteStatement,
  audit,
  auditSchemaWrites,
  buildProductionWriteIndex,
  countWriteHits,
  extractMergedPrRefsFromGitLog,
  extractWriteStatements,
  formatHistoricalRetention,
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
  theta_hat: doublePrecision('theta_hat'),
});
`;
    const fields = parseSchema(src);
    const byField = Object.fromEntries(fields.map((f) => [f.field, f.type]));
    expect(byField.prompt_md).toBe('text');
    expect(byField.embedding).toBe('vector');
    expect(byField.difficulty).toBe('real');
    // YUK-495: doublePrecision must be a recognized native constructor, else
    // widened θ̂ columns silently drop out of write-path drift detection.
    expect(byField.theta_hat).toBe('doublePrecision');
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

// YUK-166 follow-up: the chain parser must understand drizzle upsert
// (`.insert(t).values(...).onConflictDoUpdate({ set: {...} })`), bare-identifier
// `.values(ident)`, and must bound the `.values(`/`.onConflictDoUpdate(` search to
// the CURRENT statement so a later insert does not bleed into an earlier one.
describe('extractWriteStatements upsert + bare-ident + statement bounding (YUK-166)', () => {
  // F1: onConflictDoUpdate({ set: {...} }) columns are UPDATE write paths.
  it('attributes onConflictDoUpdate set-object keys as UPDATE writes on the inserted table', () => {
    const src = 'db.insert(t).values({ a: 1 }).onConflictDoUpdate({ target: t.a, set: { b: 2 } });';
    const stmts = extractWriteStatements(src);
    // The inline INSERT payload still carries `a`.
    expect(stmts).toContainEqual({ kind: 'insert', table: 't', payload: '{ a: 1 }' });
    // The set-object surfaces as an UPDATE statement scoped to `t` carrying `b`.
    const upd = stmts.find((s) => s.kind === 'update' && s.table === 't');
    expect(upd).toBeDefined();
    expect(upd?.payload).toContain('b');
    // Field-level: b is detected as an UPDATE write on t (FAILS on pre-fix code).
    const idx = new Map([['f.ts', stmts]]);
    expect(countWriteHits('t', 'b', idx)).toEqual({ insert_files: 0, update_files: 1 });
    expect(countWriteHits('t', 'a', idx)).toEqual({ insert_files: 1, update_files: 0 });
  });

  // F2: `.values(ident)` is opaque; must NOT swallow the chained onConflictDoUpdate
  // object as the insert payload (which would falsely satisfy unrelated columns).
  it('treats .values(bareIdentifier) as an opaque insert and does not misattribute the onConflictDoUpdate set object', () => {
    const src =
      'db.insert(t).values(row).onConflictDoUpdate({ target: t.scope_key, set: { x: row.x } });';
    const stmts = extractWriteStatements(src);
    // `target`/`scope_key` must NOT appear as INSERT-payload columns of t.
    const ins = stmts.find((s) => s.kind === 'insert' && s.table === 't');
    expect(ins).toBeDefined();
    expect(ins?.payload).not.toContain('target');
    expect(ins?.payload).not.toContain('scope_key');
    const idx = new Map([['f.ts', stmts]]);
    // x is an UPDATE write via set, never a (mis)counted INSERT write.
    expect(countWriteHits('t', 'x', idx).insert_files).toBe(0);
    expect(countWriteHits('t', 'x', idx).update_files).toBe(1);
    // scope_key (a target ref, not a real column write) is not satisfied at all.
    expect(countWriteHits('t', 'scope_key', idx)).toEqual({
      insert_files: 0,
      update_files: 0,
    });
  });

  // F3: a head insert with no .values in its own statement must not grab a later
  // statement's .values payload.
  it('bounds the .values search to the current statement so a later insert does not bleed in', () => {
    const src = 'db.insert(tableA).returning(); db.insert(tableB).values({ c: 1 });';
    const stmts = extractWriteStatements(src);
    // tableA has no .values of its own → no INSERT statement.
    const aIns = stmts.filter((s) => s.kind === 'insert' && s.table === 'tableA');
    expect(aIns).toEqual([]);
    // tableB carries c.
    expect(stmts).toContainEqual({ kind: 'insert', table: 'tableB', payload: '{ c: 1 }' });
    const idx = new Map([['f.ts', stmts]]);
    // c attributes to tableB only, never tableA (FAILS on pre-fix code).
    expect(countWriteHits('tableA', 'c', idx)).toEqual({ insert_files: 0, update_files: 0 });
    expect(countWriteHits('tableB', 'c', idx).insert_files).toBe(1);
  });

  // F1 with bare-ident insert: the real brief.ts shape — values(row) opaque, set captured.
  it('handles values(ident) + onConflictDoUpdate set as an opaque insert plus a real update', () => {
    const src = `await db
      .insert(memory_brief_note)
      .values(row)
      .onConflictDoUpdate({
        target: memory_brief_note.scope_key,
        set: { subject_id: row.subject_id, recent_week_md: row.recent_week_md },
      });`;
    const stmts = extractWriteStatements(src);
    const idx = new Map([['brief.ts', stmts]]);
    // subject_id / recent_week_md are UPDATE writes (via set), not INSERT writes.
    expect(countWriteHits('memory_brief_note', 'subject_id', idx).update_files).toBe(1);
    expect(countWriteHits('memory_brief_note', 'recent_week_md', idx).update_files).toBe(1);
    // They are NOT falsely counted as INSERT columns of the opaque values(row).
    expect(countWriteHits('memory_brief_note', 'subject_id', idx).insert_files).toBe(0);
    // `target` (a column ref, not a written column) is never a write path.
    expect(countWriteHits('memory_brief_note', 'target', idx)).toEqual({
      insert_files: 0,
      update_files: 0,
    });
  });
});

const retainedTable = 'copilot_evidence_checkpoint';
const currentSchema = readFileSync('src/db/schema.ts', 'utf8');
const retainedBlock = currentSchema.slice(
  currentSchema.indexOf('export const copilot_evidence_checkpoint ='),
  currentSchema.indexOf('export const provider_attempt ='),
);
const retentionAudit = (schema = retainedBlock, source = '') =>
  auditSchemaWrites(schema, new Map([['src/copilot/checkpoint.ts', source]]));

describe('repository discovery boundary (YUK-1375)', () => {
  it('keeps production evidence and retention violations independent of ancestor names', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'yuk1375-schema-audit-'));
    const repoRoot = join(temporaryRoot, 'ordinary', 'repo');
    const writeSource = (path: string, source: string) => {
      const file = join(repoRoot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    };
    try {
      writeSource(
        'src/db/schema.ts',
        `${retainedBlock}
export const active = pgTable('active', {
  title: text('title'),
  details_json: jsonb('details_json'),
  status: text('status'),
  excluded_only: text('excluded_only'),
  nested_only: text('nested_only'),
});`,
      );
      writeSource(
        'src/domain/rows.ts',
        `export function build(input) {
          return { title: input.title, details_json: { nested_only: input.metadata } };
        }`,
      );
      writeSource(
        'src/domain/persist.ts',
        `import { active as renamed } from '@/db/schema';
        export async function persist(row) { await db.insert(renamed).values(row); }`,
      );
      const caller = `import { build } from '@/domain/rows';
        import { persist } from './domain/persist';
        await persist(build({ title: 'Long evidence with ambiguous citations and Unicode 学習',
          metadata: { passages: [{ page: 3, offsets: [40, 120] }], discarded: true } }));`;
      writeSource('src/handler.ts', caller);
      writeSource(
        'app/update.ts',
        "await db.execute(sql`update active set status = 'sealed' where id = ${id}`);",
      );
      writeSource(
        'src/copilot/checkpoint.ts',
        'await db.update(copilot_evidence_checkpoint).set({ records_json: [{ citations: [{ page: 3 }] }] });',
      );
      for (const path of [
        'src/fixtures/seed.ts',
        'src/__fixtures__/seed.ts',
        'src/tests/seed.ts',
        'src/__tests__/seed.ts',
        'src/handler.test.ts',
        'src/handler.spec.tsx',
        'src/handler.fixture.ts',
        'src/rehearsal/seed.ts',
        'src/handler.rehearsal.ts',
        'src/api.generated.ts',
        'src/handler.d.ts',
      ]) {
        writeSource(
          path,
          `import { persist } from '@/domain/persist';
          await persist({ excluded_only: 'fixture caller must not supply production evidence' });
          db.insert(active).values({ excluded_only: 'fixture write' });
          await db.execute(sql\`update active set excluded_only = 'fixture SQL'\`);
          db.insert(copilot_evidence_checkpoint).values({ id: 'fixture checkpoint' });`,
        );
      }

      const baseline = audit(repoRoot);
      expect(baseline.results.filter((field) => field.table === 'active')).toEqual([
        {
          table: 'active',
          field: 'title',
          type: 'text',
          insert_files: 1,
          update_files: 0,
          status: 'init-only',
        },
        {
          table: 'active',
          field: 'details_json',
          type: 'jsonb',
          insert_files: 1,
          update_files: 0,
          status: 'init-only',
        },
        {
          table: 'active',
          field: 'status',
          type: 'text',
          insert_files: 0,
          update_files: 1,
          status: 'update-only',
        },
        {
          table: 'active',
          field: 'excluded_only',
          type: 'text',
          insert_files: 0,
          update_files: 0,
          status: 'stub',
        },
        {
          table: 'active',
          field: 'nested_only',
          type: 'text',
          insert_files: 0,
          update_files: 0,
          status: 'stub',
        },
      ]);
      for (const ancestor of ['test-storage', 'spec-worktree', 'fixtures']) {
        const relocatedRoot = join(temporaryRoot, ancestor, 'repo');
        cpSync(repoRoot, relocatedRoot, { recursive: true });
        const relocated = audit(relocatedRoot);
        expect(relocated.results, ancestor).toEqual(baseline.results);
        expect(relocated.historicalRetention, ancestor).toEqual(baseline.historicalRetention);
      }
      expect(baseline.historicalRetention.issues).toEqual([
        expect.objectContaining({
          code: 'production_write',
          kind: 'update',
          path: 'src/copilot/checkpoint.ts',
        }),
      ]);

      writeSource('src/handler.ts', caller.replace('await persist(build(', 'await unknown(build('));
      const withoutCaller = audit(repoRoot);
      for (const field of ['title', 'details_json', 'excluded_only']) {
        expect(withoutCaller.results).toContainEqual(
          expect.objectContaining({ table: 'active', field, insert_files: 0, status: 'stub' }),
        );
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('ADR-0058 / YUK-939 historical checkpoint retention', () => {
  it('keeps every retained column visible with rationale in JSON and text, including defaults', () => {
    const report = retentionAudit();
    expect(report.historicalRetention.issues).toEqual([]);
    expect(report.results).toHaveLength(19);
    expect(report.results.every((field) => field.status === 'historical-retained')).toBe(true);
    expect(
      report.results.every((field) => field.insert_files === 0 && field.update_files === 0),
    ).toBe(true);
    const json = JSON.stringify(report);
    const text = formatHistoricalRetention(report.historicalRetention);
    for (const name of ['id', 'created_at', 'updated_at', 'records_json', 'expires_at']) {
      expect(json).toContain(name);
      expect(text).toContain(name);
    }
    expect(json).toContain('ADR-0058');
    expect(text).toContain('YUK-939');
    expect(text).toContain('19');
  });

  it.each([
    ['', 'missing_table'],
    [
      retainedBlock.replace(
        "timestamp('expires_at', { withTimezone: true })",
        "timestamp('expires_at', { withTimezone: false })",
      ),
      'changed_column_type',
    ],
    [retainedBlock.replace("    slot: text('slot').notNull(),", ''), 'missing_column'],
    [
      retainedBlock.replace("    slot: text('slot')", "    slot: integer('slot')"),
      'changed_column_type',
    ],
    [
      retainedBlock.replace("    slot: text('slot')", "    slot: text('renamed_slot')"),
      'missing_column',
    ],
    [
      retainedBlock.replace("    slot: text('slot')", "    slot: customType('slot')"),
      'changed_column_type',
    ],
    [retainedBlock.replace('    id:', "    extra: jsonb('extra'),\n    id:"), 'added_column'],
    [retainedBlock.replace('    id:', "    extra: customType('extra'),\n    id:"), 'added_column'],
  ])('rejects a missing table or changed complete column inventory (%s)', (schema, code) => {
    expect(retentionAudit(schema).historicalRetention.issues).toContainEqual(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    [
      'insert',
      "await tx.insert(copilot_evidence_checkpoint).values({ id: 'cp-1', task_kind: 'CopilotEvidenceReviewTask', slot: 'research', protocol_version: 2, records_json: [{ source_id: 'paper-1', excerpt: 'Long historical evidence with nested citations', citations: [{ page: 3, offsets: [40, 120] }] }], expires_at: new Date() });",
    ],
    [
      'update',
      "await tx.update(copilot_evidence_checkpoint).set({ status: 'sealed', revision: 4, sealed_output_json: { summary: 'Historical evidence conclusion', sources: [{ id: 'paper-1', passages: ['long excerpt'] }] } }).where(eq(copilot_evidence_checkpoint.id, id));",
    ],
    [
      'insert',
      "db.insert(copilot_evidence_checkpoint).values({ id: 'cp-2', created_at: new Date() });",
    ],
    ['insert', 'db.insert(copilot_evidence_checkpoint).values(opaquePayload);'],
    [
      'update',
      'db.update(copilot_evidence_checkpoint).set(opaquePayload).where(eq(copilot_evidence_checkpoint.id, id));',
    ],
    ['update', "db.update(copilot_evidence_checkpoint).set({ unknown_field: 'unrecognized' });"],
    [
      'update',
      'db.insert(copilot_evidence_checkpoint).values({ id }).onConflictDoUpdate({ target: copilot_evidence_checkpoint.id, set: opaquePayload });',
    ],
    [
      'insert',
      'await tx.execute(sql`insert into copilot_evidence_checkpoint (id, records_json) values (${id}, ${JSON.stringify(records)})`);',
    ],
    [
      'update',
      'await tx.execute(sql`update copilot_evidence_checkpoint c set records_json = ${records}, revision = revision + 1 where c.id = ${id}`);',
    ],
    [
      'insert',
      'await tx.execute(sql`insert into copilot_evidence_checkpoint (id) values (${id})`);',
    ],
    ['insert', 'await tx.execute(sql`insert into copilot_evidence_checkpoint default values`);'],
    [
      'insert',
      'await tx.execute(sql`insert into copilot_evidence_checkpoint values (${opaquePayload})`);',
    ],
    [
      'update',
      'await tx.execute(sql`update copilot_evidence_checkpoint set ${opaqueAssignment} where id = ${id}`);',
    ],
  ])('rejects table-level %s independently of field evidence: %s', (kind, source) => {
    expect(retentionAudit(retainedBlock, source).historicalRetention.issues).toContainEqual(
      expect.objectContaining({
        code: 'production_write',
        kind,
        path: 'src/copilot/checkpoint.ts',
      }),
    );
  });

  it('preserves opaque UPDATE table evidence in the production index', () => {
    expect(
      buildProductionWriteIndex(
        new Map([['src/writer.ts', 'db.update(copilot_evidence_checkpoint).set(opaquePayload);']]),
      ).get('src/writer.ts'),
    ).toContainEqual({ kind: 'update', table: retainedTable, payload: '{}' });
  });

  it('does not reject fixture writes, read-only exports, unused SQL or database defaults', () => {
    const sources = new Map([
      [
        'src/export.ts',
        "const historical = await db.select().from(copilot_evidence_checkpoint); const docs = sql`update copilot_evidence_checkpoint set status = 'sealed'`;",
      ],
      [
        'src/copilot/checkpoint.test.ts',
        'db.update(copilot_evidence_checkpoint).set(opaquePayload);',
      ],
      [
        'src/fixtures/checkpoint.ts',
        "db.insert(copilot_evidence_checkpoint).values({ id: 'fixture' });",
      ],
      ['src/db/schema.ts', retainedBlock],
    ]);
    expect(auditSchemaWrites(retainedBlock, sources).historicalRetention.issues).toEqual([]);
  });

  it('does not excuse unrelated stubs or expired allowances', () => {
    const report = retentionAudit(
      `${retainedBlock}export const active = pgTable('active', {\n  pending: text('pending'),\n});`,
    );
    expect(report.results).toContainEqual(
      expect.objectContaining({ table: 'active', field: 'pending', status: 'stub' }),
    );
    const hygiene = validateAllowlistHygiene(
      {
        'active.pending': {
          reason: 'Still awaiting a live writer',
          resolves_when: { kind: 'manual', ref: 'YUK-1113', expected_by: '2026-10-05' },
        },
      },
      { ...OPTIONS, today: '2026-10-06' },
    );
    expect(hygiene.issues).toContainEqual(
      expect.objectContaining({ key: 'active.pending', code: 'expired_expected_by' }),
    );
  });
});

describe('YUK-1356 immutable judge incarnation initialization', () => {
  const migrationPath = 'drizzle/0118_yuk1356_judge_durable.sql';
  const journalPath = 'drizzle/meta/_journal.json';
  const currentSchema = readFileSync('src/db/schema.ts', 'utf8');
  const schema = currentSchema.slice(
    currentSchema.indexOf('export const judge_run_control ='),
    currentSchema.indexOf('export const prune_job_events_control ='),
  );
  const migration = readFileSync(migrationPath, 'utf8');
  const journal = readFileSync(journalPath, 'utf8');
  const firstBatch = migration.split('--> statement-breakpoint')[0];
  const seed = firstBatch.slice(firstBatch.indexOf('INSERT INTO'));
  const registration = {
    idx: 118,
    version: '7',
    when: 1791504000002,
    tag: '0118_yuk1356_judge_durable',
    breakpoints: true,
  };
  const duplicate = (entry: typeof registration) =>
    journal.replace('"entries": [', `"entries": [${JSON.stringify(entry)},`);

  function fixture(
    change: {
      schema?: string;
      migration?: string | null;
      journal?: string | null;
      source?: string;
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'yuk1356-init-audit-'));
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    try {
      write('src/db/schema.ts', change.schema ?? schema);
      if (change.migration !== null) write(migrationPath, change.migration ?? migration);
      if (change.journal !== null) write(journalPath, change.journal ?? journal);
      if (change.source) write('src/control.ts', change.source);
      return audit(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  function expectRejected(report: ReturnType<typeof audit>) {
    expect(report.judgeInitializationIssues.length).toBeGreaterThan(0);
    const field = report.results.find(
      (r) => r.table === 'judge_run_control' && r.field === 'incarnation',
    );
    expect(field?.initialization).toBeUndefined();
    expect(field?.status).not.toBe('init-only');
  }

  it('binds the actual declaration and unique 0118 seed, with no production INSERT evidence', () => {
    const report = fixture();
    expect(report.judgeInitializationIssues).toEqual([]);
    expect(report.results).toContainEqual({
      table: 'judge_run_control',
      field: 'incarnation',
      type: 'uuid',
      insert_files: 0,
      update_files: 0,
      status: 'init-only',
      initialization: { migration: migrationPath, values: ['gen_random_uuid()'] },
    });
    expect(report.results).toContainEqual(
      expect.objectContaining({ field: 'epoch', status: 'stub' }),
    );
  });

  it.each([
    ['missing migration', { migration: null }],
    ['missing journal', { journal: null }],
    ['missing schema', { schema: '' }],
    ['unrelated SQL', { migration: 'CREATE TABLE other (incarnation uuid);' }],
    ['malformed journal', { journal: '{' }],
    ['missing entries', { journal: '{"version":"7","dialect":"postgresql"}' }],
    ['empty entries', { journal: '{"version":"7","dialect":"postgresql","entries":[]}' }],
    ['wrong tag', { journal: journal.replace(registration.tag, '0118_other') }],
    ['wrong index', { journal: journal.replace('"idx": 118', '"idx": 119') }],
    ['wrong version', { journal: journal.replaceAll('"version": "7"', '"version": "6"') }],
    ['wrong dialect', { journal: journal.replace('postgresql', 'sqlite') }],
    ['wrong timestamp', { journal: journal.replace('1791504000002', '1791504000003') }],
    [
      'disabled breakpoints',
      {
        journal: journal.replace(
          /("tag": "0118_yuk1356_judge_durable",\s*"breakpoints": )true/,
          '$1false',
        ),
      },
    ],
    ['duplicate registration', { journal: duplicate(registration) }],
    ['colliding index', { journal: duplicate({ ...registration, tag: '0118_other' }) }],
    ['colliding tag', { journal: duplicate({ ...registration, idx: 119 }) }],
  ])('rejects %s', (_label, change) => expectRejected(fixture(change)));

  it.each([
    ['missing seed', migration.replace(seed, '')],
    ['seed in later batch', `${migration.replace(seed, '')}\n${seed}`],
    ['wrong insert table', migration.replace('INSERT INTO judge_run_control', 'INSERT INTO other')],
    ['wrong singleton', migration.replace('VALUES (1,', 'VALUES (2,')],
    ['second singleton row', migration.replace(seed, `${seed}${seed}`)],
    [
      'fixed UUID',
      migration.replace('gen_random_uuid()', "'b5ae67a2-9976-4abd-a537-dbcfbbf3a8f8'"),
    ],
    ['different generator', migration.replace('gen_random_uuid()', 'uuid_generate_v4()')],
    ['null incarnation', migration.replace('gen_random_uuid()', 'NULL')],
    ['wrong epoch', migration.replace('gen_random_uuid(), 0,', 'gen_random_uuid(), 1,')],
    ['wrong initial backend', migration.replace("0, 'pg-boss'", "0, 'dbos'")],
    ['wrong timestamp', migration.replace('clock_timestamp()', 'now()')],
    [
      'non-null transition',
      migration.replace('clock_timestamp(), NULL', "clock_timestamp(), 'fake'"),
    ],
    [
      'wrong incarnation type',
      migration.replace('incarnation uuid NOT NULL', 'incarnation text NOT NULL'),
    ],
    ['nullable incarnation', migration.replace('incarnation uuid NOT NULL', 'incarnation uuid')],
    [
      'mutable default',
      migration.replace(
        'incarnation uuid NOT NULL',
        'incarnation uuid NOT NULL DEFAULT gen_random_uuid()',
      ),
    ],
    ['singleton check', migration.replace('CHECK (id = 1)', 'CHECK (id > 0)')],
    ['epoch check', migration.replace('CHECK (epoch >= 0)', 'CHECK (epoch > 0)')],
    ['phase domain', migration.replace("'draining-dbos'", "'other'")],
    ['commented seed', migration.replace(seed, `/* ${seed} */`)],
    [
      'line-commented seed',
      migration.replace(
        seed,
        seed
          .split('\n')
          .map((line) => `-- ${line}`)
          .join('\n'),
      ),
    ],
    [
      'function seed',
      migration.replace(
        seed,
        `CREATE FUNCTION unused_seed() RETURNS void LANGUAGE SQL AS $$ ${seed} $$;`,
      ),
    ],
    [
      'unexecuted seed',
      migration.replace(seed, `DO $seed$ BEGIN IF false THEN ${seed} END IF; END $seed$;`),
    ],
    ['quoted seed', migration.replace(seed, `SELECT '${seed.replaceAll("'", "''")}';`)],
    ['commented batch', migration.replace(firstBatch, `/* ${firstBatch} */`)],
    [
      'appended incarnation change',
      `${migration}\nUPDATE judge_run_control SET incarnation = gen_random_uuid();`,
    ],
    ['appended row replacement', `${migration}\nDELETE FROM judge_run_control;\n${seed}`],
  ])('rejects SQL %s', (_label, changed) => {
    expect(changed).not.toBe(migration);
    expectRejected(fixture({ migration: changed }));
  });

  it.each([
    ['export name', schema.replace('export const judge_run_control', 'export const renamed')],
    ['SQL name', schema.replace("'judge_run_control',", "'other',")],
    ['field name', schema.replace("uuid('incarnation')", "uuid('renamed')")],
    ['property name', schema.replace('incarnation: uuid', 'renamed: uuid')],
    ['field type', schema.replace("uuid('incarnation')", "text('incarnation')")],
    ['nullable field', schema.replace("uuid('incarnation').notNull()", "uuid('incarnation')")],
    [
      'defaulted field',
      schema.replace(
        "uuid('incarnation').notNull()",
        "uuid('incarnation').notNull().defaultRandom()",
      ),
    ],
    ['singleton identity type', schema.replace("smallint('id')", "integer('id')")],
    ['singleton primary key', schema.replace('.primaryKey()', '.notNull()')],
    ['epoch type', schema.replace("bigint('epoch'", "integer('epoch'")],
    ['epoch mode', schema.replace("mode: 'number'", "mode: 'bigint'")],
    ['timestamp timezone', schema.replace('withTimezone: true', 'withTimezone: false')],
    ['singleton check', schema.replace('${t.id} = 1', '${t.id} = 2')],
    ['epoch check', schema.replace('${t.epoch} >= 0', '${t.epoch} > 0')],
    ['phase domain', schema.replace("'draining-dbos'", "'other'")],
    [
      'opaque columns',
      schema.replace('    id: smallint', '    ...unknownColumns,\n    id: smallint'),
    ],
    ['commented declaration', `/* ${schema} */`],
    ['local declaration', `function unused() { ${schema.replace('export ', '')} }`],
    ['duplicate declaration', `${schema}\n${schema}`],
  ])('rejects Drizzle %s', (_label, changed) => {
    expect(changed).not.toBe(schema);
    expectRejected(fixture({ schema: changed }));
  });

  it.each([
    [
      'Drizzle UPDATE',
      'await db.update(judge_run_control).set({ incarnation: crypto.randomUUID() });',
    ],
    [
      'SQL UPDATE',
      'await db.execute(sql`UPDATE judge_run_control SET incarnation = gen_random_uuid() WHERE id = 1`);',
    ],
    [
      'Drizzle INSERT',
      'await db.insert(judge_run_control).values({ id: 1, incarnation: crypto.randomUUID() });',
    ],
    [
      'SQL INSERT',
      "await db.execute(sql`INSERT INTO judge_run_control VALUES (1, gen_random_uuid(), 0, 'pg-boss', now(), NULL)`);",
    ],
    [
      'upsert',
      'await db.insert(judge_run_control).values({ id: 1 }).onConflictDoUpdate({ target: judge_run_control.id, set: { incarnation: crypto.randomUUID() } });',
    ],
    ['opaque UPDATE', 'await db.update(judge_run_control).set(patch);'],
    ['spread UPDATE', 'await db.update(judge_run_control).set({ epoch: 2, ...patch });'],
    ['identity UPDATE', 'await db.update(judge_run_control).set({ id: 2 });'],
    [
      'computed UPDATE',
      'await db.update(judge_run_control).set({ epoch: 2, [column]: crypto.randomUUID() });',
    ],
    [
      'computed literal UPDATE',
      'await db.update(judge_run_control).set({ phase: "dbos", ["incarnation"]: crypto.randomUUID() });',
    ],
    [
      'getter UPDATE',
      'await db.update(judge_run_control).set({ epoch: 2, get incarnation() { return crypto.randomUUID(); } });',
    ],
  ])('rejects production %s independently of the valid migration', (_label, source) => {
    const report = fixture({ source });
    expectRejected(report);
    expect(report.judgeInitializationIssues).toContainEqual(
      expect.objectContaining({ code: 'production_write', path: 'src/control.ts' }),
    );
  });

  it('retains the real operator transitions while preserving incarnation', () => {
    const source = readFileSync('src/server/durable/judge-family.ts', 'utf8');
    const report = fixture({ source });
    expect(report.judgeInitializationIssues).toEqual([]);
    expect(report.results).toContainEqual(
      expect.objectContaining({
        field: 'incarnation',
        status: 'init-only',
        insert_files: 0,
        update_files: 0,
      }),
    );
    expect(report.results).toContainEqual(
      expect.objectContaining({ field: 'epoch', update_files: 1 }),
    );
  });

  it('does not borrow unrelated migration, runtime documentation or test fixtures', () => {
    expectRejected(
      fixture({
        migration: null,
        source: `// ${seed}\nconst documentation = ${JSON.stringify(seed)};`,
      }),
    );
    const report = auditSchemaWrites(
      schema,
      new Map([
        [
          'src/control.unit.test.ts',
          'db.update(judge_run_control).set({ incarnation: "fixture" });',
        ],
      ]),
      new Map([
        [migrationPath, migration],
        [journalPath, journal],
      ]),
    );
    expect(report.judgeInitializationIssues).toEqual([]);
    expect(report.results).toContainEqual(
      expect.objectContaining({ field: 'incarnation', insert_files: 0, update_files: 0 }),
    );
    expectRejected(
      auditSchemaWrites(
        schema,
        new Map(),
        new Map([
          ['drizzle/0119_unregistered.sql', migration],
          [journalPath, journal],
        ]),
      ),
    );
  });
});
