import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildProductionWriteIndex,
  countWriteHits,
  extractWriteStatements,
} from './audit-schema-writes';

function hits(source: string, table: string, field: string) {
  return countWriteHits(table, field, new Map([['runtime.ts', extractWriteStatements(source)]]));
}

const producers = [
  ['src/kernel/events/events.ts', 'event', 'actor_ref'],
  ['src/server/memory/brief.ts', 'memory_brief_note', 'scope_key'],
  ['src/capabilities/notes/server/block-refs.ts', 'artifact_block_ref', 'ref_kind'],
  ['src/server/projections/item_calibration.ts', 'item_calibration', 'irt_a'],
  ['src/capabilities/ingestion/server/persist-image-asset.ts', 'source_asset', 'width'],
  ['src/capabilities/ingestion/server/persist-image-asset.ts', 'source_asset', 'height'],
] as const;

describe('production object evidence', () => {
  it.each(producers)(
    'finds actual construction in %s and loses a deleted field',
    (path, table, field) => {
      const source = readFileSync(path, 'utf8');
      expect(hits(source, table, field).insert_files).toBe(1);
      // Rename the actual construction key while retaining property reads, types,
      // comments and unrelated fields: those cannot substitute for the writer.
      const mutated = source.replace(new RegExp(`\\b${field}\\s*:`, 'g'), 'removed_column:');
      expect(mutated).not.toBe(source);
      expect(hits(mutated, table, field)).toEqual({ insert_files: 0, update_files: 0 });
      expect(hits(source, 'other_table', field)).toEqual({ insert_files: 0, update_files: 0 });
    },
  );

  it('resolves local returns, map callbacks, spreads and shorthand conflict set', () => {
    const source = `
      function row(input) { return { actor_ref: input.actor, metadata: { phantom: true } }; }
      const rows = inputs.map(row);
      const set = { status: 'done' } satisfies Partial<Row>;
      db.insert(event).values(rows).onConflictDoUpdate({ target: event.id, set });
      db.insert(other).values({ id: 1, ...set } as Row);
    `;
    expect(hits(source, 'event', 'actor_ref').insert_files).toBe(1);
    expect(hits(source, 'event', 'status')).toEqual({ insert_files: 0, update_files: 1 });
    expect(hits(source, 'other', 'status').insert_files).toBe(1);
    expect(hits(source, 'event', 'phantom')).toEqual({ insert_files: 0, update_files: 0 });
  });

  it('follows actual caller objects into a writer parameter, never its type alone', () => {
    const source = `
      async function persist(row: { scope_key: string; invented: string }) {
        await db.insert(memory_brief_note).values(row);
      }
      const row = { scope_key: 'learner', content: 'long evidence' };
      await persist(row);
    `;
    expect(hits(source, 'memory_brief_note', 'scope_key').insert_files).toBe(1);
    expect(hits(source, 'memory_brief_note', 'invented').insert_files).toBe(0);
    expect(
      hits(source.replace('await persist(row);', ''), 'memory_brief_note', 'scope_key')
        .insert_files,
    ).toBe(0);
  });

  it('keeps lexical bindings and callee return values distinct from arguments', () => {
    const source = `
      const row = { outer_only: true };
      function persist() {
        const row = { actual: true };
        db.insert(target).values(row);
      }
      function drop(input) { return { retained: input.value }; }
      db.insert(target).values(drop({ discarded: true, value: 1 }));
      db.insert(sibling).values(row);
    `;
    expect(hits(source, 'target', 'actual').insert_files).toBe(1);
    expect(hits(source, 'target', 'retained').insert_files).toBe(1);
    expect(hits(source, 'target', 'outer_only').insert_files).toBe(0);
    expect(hits(source, 'target', 'discarded').insert_files).toBe(0);
  });

  it('does not count comments, strings, nested data, constraint targets or unknown wrappers', () => {
    const source = `
      // db.insert(target).values({ comment_field: 1 });
      const docs = 'db.insert(target).values({ string_field: 1 })';
      db.insert(target).values({ payload: { nested_field: 1 }, note: 'text_field: true' })
        .onConflictDoUpdate({ target: target.constraint_field, set: { updated: 1 } });
      db.insert(target).values(unknownWrapper({ discarded: 1 }));
    `;
    for (const field of [
      'comment_field',
      'string_field',
      'nested_field',
      'text_field',
      'constraint_field',
      'discarded',
    ]) {
      expect(hits(source, 'target', field)).toEqual({ insert_files: 0, update_files: 0 });
    }
    expect(hits(source, 'target', 'payload').insert_files).toBe(1);
  });

  it('only counts pushes into the actual returned array, including invoked local visitors', () => {
    const source = `
      function build() {
        const rows = [];
        const unused = () => rows.push({ dead: true });
        const visit = (item) => rows.push({ actual: item.id });
        for (const item of inputs) visit(item);
        const unrelated = []; unrelated.push({ wrong_array: true });
        return rows;
      }
      db.insert(target).values(build());
    `;
    expect(hits(source, 'target', 'actual').insert_files).toBe(1);
    expect(hits(source, 'target', 'dead').insert_files).toBe(0);
    expect(hits(source, 'target', 'wrong_array').insert_files).toBe(0);
  });

  it('stops on cyclic variables and recursive builders without inventing fields', () => {
    const source = `const a = b; const b = a; function recurse(x) { return recurse(x); }
      db.insert(target).values(a); db.insert(target).values(recurse({ phantom: true }));`;
    expect(hits(source, 'target', 'phantom').insert_files).toBe(0);
  });
});

// Exercise the exact file-selection/index entry used by audit:schema, including
// SQL writes and imported builders, not a parallel test-only source filter.
describe('production source boundary', () => {
  it.each([
    'src/x.test.ts',
    'src/x.db.test.ts',
    'src/x.spec.tsx',
    'src/x.fixture.ts',
    'src/config-test-fixture.ts',
    'src/x-fixtures.ts',
    'src/tests/seed.ts',
    'src/test/seed.ts',
    'src/__tests__/seed.ts',
    'src/fixtures/seed.ts',
    'src/__fixtures__/seed.ts',
    'src/__mocks__/db.ts',
    'src/rehearsal/run.ts',
    'src/x.rehearsal.ts',
    'src/schema.ts',
    'src/api.generated.ts',
  ])('excludes both Drizzle and raw SQL evidence from %s', (path) => {
    const index = buildProductionWriteIndex(
      new Map([
        [
          path,
          'db.insert(target).values({ fixture_column: true }); await db.execute(sql`update target set raw_fixture_column = 1`);',
        ],
      ]),
    );
    expect(countWriteHits('target', 'fixture_column', index).insert_files).toBe(0);
    expect(countWriteHits('target', 'raw_fixture_column', index).update_files).toBe(0);
  });

  it('follows imported return construction and aliases without borrowing dropped arguments', () => {
    const source = new Map([
      [
        'src/writer.ts',
        `import { target as renamed } from './tables';
        import { build as wrapper } from '@/builder';
        db.insert(renamed).values(wrapper({ actual: true, discarded: true }));`,
      ],
      ['src/builder.ts', 'export function build(input) { return { actual: input.actual }; }'],
      ['src/tables.ts', "export const target = pgTable('target', {});"],
      ['src/builder.test.ts', 'build({ phantom: true });'],
    ]);
    const index = buildProductionWriteIndex(source);
    expect(countWriteHits('target', 'actual', index).insert_files).toBe(1);
    expect(countWriteHits('target', 'discarded', index).insert_files).toBe(0);
    expect(countWriteHits('renamed', 'actual', index).insert_files).toBe(0);
    source.set(
      'src/builder.ts',
      'export function build(input) { return { removed: input.actual }; }',
    );
    expect(countWriteHits('target', 'actual', buildProductionWriteIndex(source)).insert_files).toBe(
      0,
    );
  });

  it('does not use a test caller to satisfy a production parameter', () => {
    const source = new Map([
      ['src/writer.ts', 'export function persist(row) { db.insert(target).values(row); }'],
      [
        'src/writer.test.ts',
        "import { persist } from './writer'; persist({ fixture_column: true });",
      ],
    ]);
    expect(
      countWriteHits('target', 'fixture_column', buildProductionWriteIndex(source)).insert_files,
    ).toBe(0);
  });
});

it('preserves an aliased schema import when the schema itself is excluded', () => {
  const source = new Map([
    [
      'src/writer.ts',
      "import { question as q } from '@/db/schema'; const target = q; db.insert(target).values({ actual: true });",
    ],
    ['src/db/schema.ts', "export const question = pgTable('question', {});"],
  ]);
  const index = buildProductionWriteIndex(source);
  expect(countWriteHits('question', 'actual', index).insert_files).toBe(1);
  expect(countWriteHits('target', 'actual', index).insert_files).toBe(0);
  expect(countWriteHits('q', 'actual', index).insert_files).toBe(0);
});

it('does not use a stale initializer after an opaque variable reassignment', () => {
  const source = 'let row = { stale: true }; row = unknown(); db.insert(target).values(row);';
  expect(hits(source, 'target', 'stale').insert_files).toBe(0);
});
