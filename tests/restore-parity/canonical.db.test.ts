// Real-PG digest parity checks; runs in the DB test lane against disposable
// testcontainers (no parent lane involvement).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CATALOG_SQL,
  TYPES_SQL,
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

async function digest(metadata: TableMetadata, queryClient: ReturnType<typeof postgres>) {
  const copy = tableContentSql(metadata);
  const query = copy.slice('COPY ('.length, -') TO STDOUT;'.length);
  const rows = await queryClient.unsafe(query);
  const hash = createTableDigest(metadata);
  for (const row of rows) hash.update(`${z.object({ h: z.string() }).parse(row).h}\n`);
  return hash.finish();
}
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

describe('real PG16 partition array pg_dump/pg_restore regression', () => {
  // @invariant data: pg_dump/pg_restore round-trips inherited array values byte-exactly and rejects value or type drift
  // @fails-if the round trip rewrites array bounds or escapes; restored data silently differs from the source
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
        CREATE DOMAIN ${arrayRelation('scalar_checked_text')} AS text NOT NULL CHECK (length(VALUE)>0);
        CREATE TABLE ${arrayRelation('scalar_domain')} (value ${arrayRelation('scalar_checked_text')});
        INSERT INTO ${arrayRelation('scalar_domain')} VALUES ('检查 scalar');
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
        await arrayClient.unsafe(
          `ALTER DOMAIN ${arrayRelation('scalar_checked_text')} DROP NOT NULL`,
        );
        expect(
          compareDatabaseManifests({
            source: source.inventory,
            restored: (await arrayCatalogInventory(arrayClient)).inventory,
          }).kind,
        ).toBe('different');
        await arrayClient.unsafe(
          `ALTER DOMAIN ${arrayRelation('scalar_checked_text')} SET NOT NULL`,
        );
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
