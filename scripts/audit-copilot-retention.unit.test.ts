// biome-ignore-all lint/suspicious/noTemplateCurlyInString: These are unevaluated production SQL fixtures.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditSchemaWrites, validateAllowlistHygiene } from './audit-schema-writes';

const schema = readFileSync('src/db/schema.ts', 'utf8');
const projectionPath = 'src/capabilities/copilot/server/subagent-mailbox.ts';
const projection = readFileSync(projectionPath, 'utf8');
const report = (source = '', definition = schema) =>
  auditSchemaWrites(definition, new Map([['src/copilot/runtime.ts', source]]));
const issues = (source = '', definition = schema) =>
  report(source, definition).retainedSchemas.flatMap((retention) => retention.issues);

describe('ADR-0063 retained continuation and mixed native child schema', () => {
  it('preserves the full physical inventory and keeps actual native writes classified', () => {
    const result = auditSchemaWrites(schema, new Map([[projectionPath, projection]]));
    expect(
      result.retainedSchemas.map((retention) => [retention.table, retention.fields.length]),
    ).toEqual([
      ['copilot_evidence_checkpoint', 19],
      ['copilot_continuation', 17],
      ['subagent_run', 24],
    ]);
    expect(result.retainedSchemas.flatMap((retention) => retention.issues)).toEqual([]);
    expect(result.results.filter((field) => field.table === 'copilot_continuation')).toHaveLength(
      17,
    );
    expect(
      result.results
        .filter((field) => field.table === 'copilot_continuation')
        .every((field) => field.status === 'historical-retained'),
    ).toBe(true);
    for (const field of [
      'claim_token',
      'hard_deadline_at',
      'child_task_run_id',
      'pg_boss_job_id',
    ]) {
      expect(result.results).toContainEqual(
        expect.objectContaining({
          table: 'subagent_run',
          field,
          status: 'historical-retained',
          insert_files: 0,
          update_files: 0,
        }),
      );
    }
    for (const field of ['session_id', 'objective', 'parent_task_run_id', 'started_at']) {
      expect(result.results).toContainEqual(
        expect.objectContaining({
          table: 'subagent_run',
          field,
          status: 'init-only',
          insert_files: 1,
        }),
      );
    }
    expect(result.results).toContainEqual(
      expect.objectContaining({ table: 'subagent_run', field: 'status', status: 'live' }),
    );
    expect(result.results).toContainEqual(
      expect.objectContaining({
        table: 'subagent_run',
        field: 'lease_expires_at',
        status: 'update-only',
      }),
    );
  });

  it.each(['copilot_continuation', 'subagent_run'])(
    'fails on removing or drifting %s schema',
    (table) => {
      const start = schema.indexOf(`export const ${table} =`);
      const end = schema.indexOf('export const ', start + 1);
      const block = schema.slice(start, end);
      for (const [changed, code] of [
        ['', 'missing_table'],
        [block.replace("    id: text('id').primaryKey(),", ''), 'missing_column'],
        [block.replace("text('status')", "integer('status')"), 'changed_column_type'],
        [
          block.replace(
            "timestamp('lease_expires_at', { withTimezone: true })",
            "timestamp('lease_expires_at', { withTimezone: false })",
          ),
          'changed_column_type',
        ],
        [block.replace("text('status')", "text('renamed_status')"), 'missing_column'],
        [block.replace('    id:', "    extra: jsonb('extra'),\n    id:"), 'added_column'],
      ]) {
        expect(issues('', schema.replace(block, changed))).toContainEqual(
          expect.objectContaining({ code }),
        );
      }
    },
  );

  it.each([
    "db.insert(copilot_continuation).values({ id: 'old-root', status: 'pending' });",
    'db.update(copilot_continuation).set(opaque);',
    'db.insert(copilot_continuation).values(opaque).onConflictDoUpdate({ target: copilot_continuation.id, set: opaque });',
    'tx.execute(sql`insert into copilot_continuation default values`);',
    'tx.execute(sql`update copilot_continuation set ${opaque} where id = ${id}`);',
    "import { copilot_continuation as history } from '@/db/schema'; db.update(history).set({ updated_at: new Date() });",
  ])('forbids every continuation production write: %s', (source) => {
    expect(issues(source)).toContainEqual(expect.objectContaining({ code: 'production_write' }));
  });

  it.each(['claim_token', 'hard_deadline_at', 'child_task_run_id', 'pg_boss_job_id'])(
    'forbids retired child column %s in inserts and updates',
    (field) => {
      for (const source of [
        `db.update(subagent_run).set({ ${field}: 'legacy-owner' });`,
        `db.insert(subagent_run).values({ status: 'running', started_at: new Date(), ${field}: 'legacy-owner' });`,
      ])
        expect(issues(source)).toContainEqual(
          expect.objectContaining({ code: 'production_write' }),
        );
    },
  );

  it.each([
    'db.update(subagent_run).set({ lease_expires_at: new Date() });',
    "db.insert(subagent_run).values({ status: 'queued', started_at: new Date() });",
    "db.insert(subagent_run).values({ status: 'running' });",
    "db.insert(subagent_run).values({ status: 'running', started_at: (null) });",
    "const started = null; db.insert(subagent_run).values({ status: 'running', started_at: started });",
    "db.insert(subagent_run).values({ status: 'running', started_at: unknownDate });",
    "db.update(subagent_run).set({ status: 'queued' });",
    "db.update(subagent_run).set({ status: 'running' });",
    'db.update(subagent_run).set({ started_at: null });',
    'db.update(subagent_run).set({ status: opaqueStatus });',
    'db.update(subagent_run).set(opaque);',
    'db.update(subagent_run).set({ result_md: result, ...opaque });',
    'db.update(subagent_run).set({ [column]: value });',
    'db.insert(subagent_run).values(opaque).onConflictDoUpdate({ target: subagent_run.id, set: opaque });',
    'tx.execute(sql`update subagent_run set claim_token = ${token} where id = ${id}`);',
  ])('fails closed on legacy or unresolved mixed child writes: %s', (source) => {
    expect(issues(source)).toContainEqual(expect.objectContaining({ code: 'production_write' }));
  });

  it('accepts native literal inserts, null lease cleanup, cancellation and read-only drain evidence', () => {
    expect(
      issues(`async function settle(outcome: { status: 'succeeded' | 'failed' | 'cancelled' | 'lost' }, result: string) {
      db.insert(subagent_run).values({ status: 'running', started_at: new Date(), objective: 'A long research objective with nested evidence handled in the original parent.' });
      db.update(subagent_run).set({ lease_expires_at: null, result_md: result, status: outcome.status });
      db.update(subagent_run).set({ cancel_requested_by: owner, cancel_requested_at: new Date() });
      db.select().from(copilot_continuation); }`),
    ).toEqual([]);
  });

  it('checks every retained physical column, including the four mixed historical fields', () => {
    for (const contract of report().retainedSchemas.slice(1)) {
      for (const field of contract.fields) {
        const call = `${field.type === 'timestamp with time zone' ? 'timestamp' : field.type}('${field.field}'`;
        const start = schema.indexOf(`export const ${contract.table} =`);
        const end = schema.indexOf('export const ', start + 1);
        const block = schema.slice(start, end);
        const drifted = block.replace(call, `integer('changed_${field.field}'`);
        expect(issues('', schema.replace(block, drifted))).toContainEqual(
          expect.objectContaining({
            code: 'missing_column',
            message: expect.stringContaining(`${contract.table}.${field.field}`),
          }),
        );
      }
    }
  });

  it('keeps fixture writes separate and ordinary expired allowances enforced', () => {
    const result = auditSchemaWrites(
      schema,
      new Map([
        ['src/fixtures/legacy.ts', 'db.insert(copilot_continuation).values(opaque);'],
        ['src/copilot/runtime.test.ts', 'db.update(subagent_run).set(opaque);'],
      ]),
    );
    expect(result.retainedSchemas.flatMap((retention) => retention.issues)).toEqual([]);
    expect(
      validateAllowlistHygiene(
        {
          'active.future': {
            reason: 'Still awaiting a real producer',
            resolves_when: {
              kind: 'manual',
              ref: 'An ordinary future producer',
              expected_by: '2026-10-08',
            },
          },
        },
        { today: '2026-10-09', mergedPrRefs: new Set(), statusText: '' },
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'expired_expected_by' }));
  });
});
