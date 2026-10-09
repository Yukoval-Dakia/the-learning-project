// Prepared only in the implementation lane. Runs in the DB partition; parent owns execution.
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CATALOG_SQL,
  TYPES_SQL,
  boundarySessionSql,
  canonicalTableMetadata,
  compareDatabaseManifests,
  createTableDigest,
  quoteIdentifier,
  resolveTypeChain,
  tableContentSql,
} from '../../scripts/cutover-backup';
import {
  CONTENT_ALGORITHM,
  type DatabaseManifest,
  type TableMetadata,
  tableMetadataSchema,
} from '../../src/core/migration/cutover-manifest';

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
async function digest(metadata: TableMetadata, queryClient = client) {
  const copy = tableContentSql(metadata);
  const query = copy.slice('COPY ('.length, -') TO STDOUT;'.length);
  const rows = await queryClient.unsafe(query);
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

const arraySchema = 'restore_array_catalog';
const arrayRelation = (name: string) => `${quoteIdentifier(arraySchema)}.${quoteIdentifier(name)}`;
const rawArrayTableSchema = tableMetadataSchema.omit({ columns: true }).extend({
  populated: z.boolean(),
  columns: z.array(
    tableMetadataSchema.shape.columns.element
      .omit({ type_chain: true })
      .extend({ type_oid: z.string() }),
  ),
});
async function arrayCatalogInventory(queryClient: ReturnType<typeof postgres>) {
  const [catalogRow] = await queryClient.unsafe(CATALOG_SQL);
  const raw = z
    .object({
      json_build_object: z.object({
        encoding: z.literal('UTF8'),
        server_version: z.string().regex(/^16\./),
        extensions: z.array(z.object({ name: z.string(), version: z.string() })),
        tables: z.array(rawArrayTableSchema),
      }),
    })
    .parse(catalogRow).json_build_object;
  const [typeRow] = await queryClient.unsafe(TYPES_SQL);
  const types = z.object({ coalesce: z.unknown() }).parse(typeRow).coalesce;
  const tables = raw.tables
    .filter((table) => table.schema === arraySchema)
    .map(({ populated: _populated, ...table }) => ({
      ...table,
      columns: table.columns.map(({ type_oid, ...column }) => ({
        ...column,
        type_chain: resolveTypeChain(type_oid, types),
      })),
    }));
  const manifests: DatabaseManifest['tables'] = [];
  for (const table of tables)
    manifests.push({ ...canonicalTableMetadata(table), ...(await digest(table, queryClient)) });
  return {
    raw: tables,
    inventory: {
      algorithm: CONTENT_ALGORITHM,
      encoding: raw.encoding,
      server_version: raw.server_version,
      extensions: raw.extensions,
      schemas: [arraySchema],
      tables: manifests,
      sequences: [],
    } satisfies DatabaseManifest,
  };
}
const longArrayText = '检查🦆"\\\n'.repeat(4000);
const arrayQuote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const arrayMatrix = `[0:1][-2:-1]={{${arrayQuote(longArrayText)},NULL},{"NULL",""}}`;

describe('real PG16 partition array pg_dump/pg_restore regression (UNRUN by author)', () => {
  it('round-trips empty and populated inherited arrays, then rejects value and type changes', async () => {
    const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('test_fork_1359')
      .start();
    try {
      const uri = container.getConnectionUri();
      if (!/^\/test_fork_[0-9]+$/.test(new URL(uri).pathname))
        throw new Error('requires isolated owned DB-test fork');
      const arrayClient = postgres(uri, { max: 1 });
      try {
        for (const command of ['pg_dump', 'pg_restore']) {
          const version = await container.exec([command, '--version']);
          expect(version.exitCode, version.stderr).toBe(0);
          expect(version.stdout).toMatch(/\(PostgreSQL\) 16\./);
        }
        const archive = '/tmp/restore-array-catalog.dump';
        const connection = [
          '-h',
          '127.0.0.1',
          '-p',
          '5432',
          '-U',
          container.getUsername(),
          '-d',
          container.getDatabase(),
        ];
        const execOptions = {
          env: { PGPASSWORD: container.getPassword(), PGSSLMODE: 'disable' },
        };
        await arrayClient.unsafe(`SET search_path=pg_catalog; SET client_encoding='UTF8'; SET TimeZone='UTC';
        SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET extra_float_digits=3; SET bytea_output='hex';
        CREATE SCHEMA ${quoteIdentifier(arraySchema)};
        CREATE TYPE ${arrayRelation('phase')} AS ENUM ('created','检查','completed');
        CREATE DOMAIN ${arrayRelation('checked_text')} AS text NOT NULL CHECK (length(VALUE)>0);
        CREATE DOMAIN ${arrayRelation('matrix')} AS text[] CHECK (array_ndims(VALUE)=2);
        CREATE DOMAIN ${arrayRelation('matrices')} AS ${arrayRelation('matrix')}[];
        CREATE TABLE ${arrayRelation('parent')} (
          key int, integer_values int[], text_values text[][], enum_values ${arrayRelation('phase')}[],
          domain_values ${arrayRelation('checked_text')}[], matrix_values ${arrayRelation('matrix')},
          nested_values ${arrayRelation('matrices')}) PARTITION BY LIST(key);
        CREATE TABLE ${arrayRelation('populated')} PARTITION OF ${arrayRelation('parent')} FOR VALUES IN (1);
        CREATE TABLE ${arrayRelation('empty')} PARTITION OF ${arrayRelation('parent')} FOR VALUES IN (2);`);
        for (let i = 0; i < 2; i++)
          await arrayClient.unsafe(
            `INSERT INTO ${arrayRelation('parent')} VALUES
        (1,'[0:1][-2:-1]={{1,NULL},{3,4}}',$1::text[],
        '[0:1][-2:-1]={{created,NULL},{检查,completed}}',ARRAY['a','检查']::${arrayRelation('checked_text')}[],
        $1::${arrayRelation('matrix')},$2::${arrayRelation('matrices')})`,
            [arrayMatrix, `[0:0]={${arrayQuote(arrayMatrix)}}`],
          );
        await arrayClient.unsafe(
          `INSERT INTO ${arrayRelation('parent')} VALUES (1,NULL,'{}','{}','{}',NULL,NULL)`,
        );
        const source = await arrayCatalogInventory(arrayClient);
        expect(
          source.raw
            .find((table) => table.name === 'populated')
            ?.columns.find((column) => column.name === 'integer_values')?.dimensions,
        ).toBe(0);
        expect(
          source.raw
            .find((table) => table.name === 'empty')
            ?.columns.find((column) => column.name === 'integer_values')?.dimensions,
        ).toBe(0);
        const dumped = await container.exec(
          [
            'pg_dump',
            ...connection,
            '-Fc',
            '--no-owner',
            '--no-privileges',
            `--schema=${arraySchema}`,
            '-f',
            archive,
          ],
          execOptions,
        );
        expect(dumped.exitCode, dumped.stderr).toBe(0);
        await arrayClient.unsafe(`DROP SCHEMA ${quoteIdentifier(arraySchema)} CASCADE`);
        const restored = await container.exec(
          [
            'pg_restore',
            ...connection,
            '--single-transaction',
            '--exit-on-error',
            '--no-owner',
            '--no-privileges',
            archive,
          ],
          execOptions,
        );
        expect(restored.exitCode, restored.stderr).toBe(0);
        const targetInventory = await arrayCatalogInventory(arrayClient);
        for (const name of ['populated', 'empty'])
          expect(
            targetInventory.raw
              .find((table) => table.name === name)
              ?.columns.find((column) => column.name === 'integer_values')?.dimensions,
          ).toBe(1);
        expect(
          compareDatabaseManifests({
            source: source.inventory,
            restored: targetInventory.inventory,
          }).kind,
        ).toBe('equal');
        expect(
          targetInventory.inventory.tables.find((table) => table.name === 'populated')?.rows,
        ).toBe('3');
        for (const value of [
          `{${arrayQuote(longArrayText)},NULL,"NULL",""}`,
          arrayMatrix.replace('[0:1][-2:-1]', '[1:2][1:2]'),
          `[0:1][-2:-1]={{NULL,${arrayQuote(longArrayText)}},{"NULL",""}}`,
          arrayMatrix.replace('检查', '改变'),
          arrayMatrix.replace(',NULL', ',"NULL"'),
          '{}',
          null,
        ]) {
          await arrayClient.unsafe(
            `UPDATE ${arrayRelation('populated')} SET text_values=$1::text[] WHERE matrix_values IS NOT NULL`,
            [value],
          );
          const changed = await arrayCatalogInventory(arrayClient);
          expect(changed.inventory.tables.find((table) => table.name === 'populated')?.rows).toBe(
            '3',
          );
          expect(
            compareDatabaseManifests({ source: source.inventory, restored: changed.inventory })
              .kind,
          ).toBe('different');
        }
        await arrayClient.unsafe(
          `UPDATE ${arrayRelation('populated')} SET text_values=$1::text[] WHERE matrix_values IS NOT NULL`,
          [arrayMatrix],
        );
        expect(
          compareDatabaseManifests({
            source: source.inventory,
            restored: (await arrayCatalogInventory(arrayClient)).inventory,
          }).kind,
        ).toBe('equal');
        await expect(
          arrayClient.unsafe(`SELECT ''::${arrayRelation('checked_text')}`),
        ).rejects.toThrow(/check constraint/);
        await expect(
          arrayClient.unsafe(`SELECT '{a,b}'::${arrayRelation('matrix')}`),
        ).rejects.toThrow(/check constraint/);
        await arrayClient.unsafe(`ALTER DOMAIN ${arrayRelation('checked_text')} DROP NOT NULL`);
        expect(
          compareDatabaseManifests({
            source: source.inventory,
            restored: (await arrayCatalogInventory(arrayClient)).inventory,
          }).kind,
        ).toBe('different');
        await arrayClient.unsafe(`ALTER DOMAIN ${arrayRelation('checked_text')} SET NOT NULL`);
        expect(
          compareDatabaseManifests({
            source: source.inventory,
            restored: (await arrayCatalogInventory(arrayClient)).inventory,
          }).kind,
        ).toBe('equal');
        await arrayClient.unsafe(
          `ALTER TABLE ${arrayRelation('parent')} ALTER COLUMN integer_values TYPE bigint[] USING integer_values::bigint[]`,
        );
        expect(
          compareDatabaseManifests({
            source: source.inventory,
            restored: (await arrayCatalogInventory(arrayClient)).inventory,
          }).kind,
        ).toBe('different');
      } finally {
        try {
          await arrayClient.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(arraySchema)} CASCADE`);
        } finally {
          await arrayClient.end();
        }
      }
    } finally {
      await container.stop();
    }
  }, 120000);
});
