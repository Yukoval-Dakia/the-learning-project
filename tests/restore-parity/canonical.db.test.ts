// Prepared only in the implementation lane. Runs in the DB partition; parent owns execution.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CATALOG_SQL,
  boundarySessionSql,
  createTableDigest,
  quoteIdentifier,
  tableContentSql,
} from '../../scripts/cutover-backup';
import type { TableMetadata } from '../../src/core/migration/cutover-manifest';

const schema = 'restore.检查"\nfixture';
const qualified = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
let client: ReturnType<typeof postgres>;
const table = (name: string, kind: TableMetadata['kind'] = 'r'): TableMetadata => ({
  schema,
  name,
  kind,
  persistence: 'p',
  partition: name === 'leaf',
  partition_bound: null,
  parents: [],
  columns: ['payload', 'state', 'large_id', 'binary', 'embedding'].map((name) => {
    const type =
      name === 'payload'
        ? { schema: 'pg_catalog', name: 'json' }
        : name === 'state'
          ? { schema, name: 'job_state' }
          : name === 'large_id'
            ? { schema: 'pg_catalog', name: 'int8' }
            : name === 'binary'
              ? { schema: 'pg_catalog', name: 'bytea' }
              : { schema: 'public', name: 'vector' };
    const kind = name === 'state' ? 'enum' : name === 'embedding' ? 'vector' : 'builtin';
    return {
      name,
      type,
      type_chain: [
        {
          ...type,
          kind,
          enum_labels:
            kind === 'enum'
              ? ['created', 'retry', 'active', 'completed', 'cancelled', 'failed']
              : [],
          domain_not_null: false,
          modifier: -1,
        },
      ],
      modifier: name === 'embedding' ? 3 : -1,
      dimensions: 0,
      collation: null,
    };
  }),
});
async function digest(metadata: TableMetadata) {
  const copy = tableContentSql(metadata);
  const query = copy.slice('COPY ('.length, -') TO STDOUT;'.length);
  const rows = await client.unsafe(query);
  const hash = createTableDigest(metadata);
  for (const row of rows) hash.update(`${z.object({ h: z.string() }).parse(row).h}\n`);
  return hash.finish();
}
beforeAll(async () => {
  client = postgres(z.string().parse(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL), {
    max: 1,
  });
  await client.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)};
    CREATE TYPE ${qualified('job_state')} AS ENUM ('created','retry','active','completed','cancelled','failed');
    CREATE TABLE ${qualified('parent')} (payload json, state ${qualified('job_state')}, large_id bigint, "binary" bytea, embedding public.vector(3)) PARTITION BY LIST(state);
    CREATE TABLE ${qualified('leaf')} PARTITION OF ${qualified('parent')} FOR VALUES IN ('completed');
    CREATE TABLE ${qualified('plain')} (LIKE ${qualified('parent')});
    CREATE TABLE ${qualified('zero')} ();
    CREATE SEQUENCE ${qualified('never')} AS bigint CACHE 32;
    SELECT setval(${`'${qualified('never').replaceAll("'", "''")}'`}::regclass,9007199254741001,false);`);
  const payload = JSON.stringify({
    text: 'null\n"\\检查',
    nested: { values: [null, 'null', '', '🦆'] },
    long: 'x'.repeat(20000),
  });
  for (let i = 0; i < 2; i++)
    await client.unsafe(
      `INSERT INTO ${qualified('leaf')} VALUES ($1::json,'completed',9007199254741001,decode('00ff0a','hex'),'[1,2,3]')`,
      [payload],
    );
  await client.unsafe(`INSERT INTO ${qualified('plain')} SELECT * FROM ONLY ${qualified('leaf')}`);
});
afterAll(async () => {
  if (client) {
    await client.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await client.end();
  }
});
describe('actual PG16 logical bytes (UNRUN by author)', () => {
  it('hashes enum/vector/bigint/long JSON/binary and duplicate rows, independent of physical order', async () => {
    const a = await digest(table('leaf'));
    await client.unsafe(
      `CREATE TABLE ${qualified('reordered')} (LIKE ${qualified('plain')}); INSERT INTO ${qualified('reordered')} SELECT * FROM ${qualified('plain')} ORDER BY ctid DESC;`,
    );
    expect(await digest(table('reordered'))).toEqual(a);
    expect(a.rows).toBe('2');
    await client.unsafe(`UPDATE ${qualified('plain')} SET large_id=9007199254741002`);
    const changed = await digest(table('plain'));
    expect(changed.rows).toBe(a.rows);
    expect(changed.sha256).not.toBe(a.sha256);
  });
  it('ONLY parent has zero local rows and never-called large sequence remains exact', async () => {
    expect((await digest(table('parent', 'p'))).rows).toBe('0');
    expect((await digest({ ...table('zero'), columns: [] })).rows).toBe('0');
    const [state] = await client.unsafe(
      `SELECT last_value::text,is_called FROM ${qualified('never')}`,
    );
    expect(state).toMatchObject({ last_value: '9007199254741001', is_called: false });
  });
  it('real catalog query includes quoted schema, parent and leaf under fixed inspector settings', async () => {
    const rows = await client.unsafe(CATALOG_SQL);
    const row = z
      .object({
        json_build_object: z.object({
          schemas: z.array(z.string()),
          tables: z.array(
            z.object({
              schema: z.string(),
              name: z.string(),
              kind: z.string(),
              parents: z.array(z.object({ schema: z.string(), name: z.string() })),
            }),
          ),
        }),
      })
      .parse(rows.at(-1));
    expect(row.json_build_object.schemas).toContain(schema);
    expect(
      row.json_build_object.tables.find((t) => t.schema === schema && t.name === 'leaf')?.parents,
    ).toEqual([{ schema, name: 'parent' }]);
  });
  it.each([
    ['logical replication launcher', false, '0'],
    ['checkpointer', false, '0'],
    ['client backend', false, '1'],
    ['client backend', true, '1'],
    ['logical replication worker', false, '1'],
    ['walsender', false, '1'],
    ['background worker', false, '1'],
    ['parallel worker', false, '1'],
    ['autovacuum worker', true, '1'],
  ])(
    'classifies %s (active=%s) through the actual SQL predicate',
    async (backend, active, expected) => {
      const literal = `'${String(backend).replaceAll("'", "''")}'`;
      const sql = `WITH pg_stat_activity AS (SELECT 999999::int AS pid, ${literal}::text AS backend_type, ${active ? 'now()' : 'NULL::timestamptz'} AS xact_start) ${boundarySessionSql()}`;
      const [row] = await client.unsafe(sql);
      expect(
        z.object({ json_build_object: z.object({ unowned: z.string() }) }).parse(row)
          .json_build_object.unowned,
      ).toBe(expected);
    },
  );
  it('exempts the exact keeper PID, never an application_name lookalike', async () => {
    const query = `WITH pg_stat_activity AS (SELECT pid, 'client backend'::text AS backend_type, NULL::timestamptz AS xact_start FROM (VALUES (123),(124)) AS fixture(pid)) ${boundarySessionSql(123)}`;
    const [row] = await client.unsafe(query);
    expect(
      z.object({ json_build_object: z.object({ unowned: z.string() }) }).parse(row)
        .json_build_object.unowned,
    ).toBe('1');
  });
});
