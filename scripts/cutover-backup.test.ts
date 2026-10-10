import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stableStringify } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import {
  CONTENT_ALGORITHM,
  type CurrentRestoreReceipt,
  type DatabaseManifest,
  type QuiescenceEvidence,
  type SourceManifest,
  type TableMetadata,
} from '@/core/migration/cutover-manifest';
import { buildMigrationManifest } from '@/core/migration/manifest';
import { emptyCapture } from '@/core/migration/test-fixtures';

import {
  artifactIdentity,
  buildManifest,
  canonicalTableMetadata,
  compareDatabaseManifests,
  createTableDigest,
  finalizeRestoreEvidence,
  parseCutoverBackupArgs,
  parseDatabaseManifest,
  parseRestoreReceipt,
  parseScratchAccess,
  parseSourceManifest,
  quoteIdentifier,
  readJsonArtifact,
  requiredMissing,
  resolveTypeChain,
  tableContentSql,
  validateArtifactBindings,
  validateExecutionArtifacts,
} from './cutover-backup';

// YUK-1056 — cutover-backup CLI 单测（纯 fs/对象；不触 DB/docker）。

const TMP = mkdtempSync(join(tmpdir(), 'cutover-backup-test-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('P1-1 restore evidence 绑定当前 dump', () => {
  const CAP = join(TMP, 'p1cap');
  const DUMP = join(TMP, 'p1.dump');
  const DLQ = join(TMP, 'p1-dlq.json');
  const minimalManifest = migrationFixture();
  mkdirSync(CAP, { recursive: true });
  writeFileSync(join(CAP, 'manifest-h1.json'), JSON.stringify(minimalManifest));
  writeFileSync(join(CAP, 'latest.json'), JSON.stringify({ manifest_file: 'manifest-h1.json' }));
  writeFileSync(DUMP, 'dumpbytes');
  writeFileSync(DLQ, JSON.stringify([{ name: 'x_dlq' }]));
  const dumpSha = createHash('sha256').update('dumpbytes').digest('hex');

  const writeEvidence = (name: string, body: Record<string, unknown>): string => {
    const p = join(TMP, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  const build = (evi: string) =>
    buildManifest(
      parseCutoverBackupArgs([
        `--capture-dir=${CAP}`,
        `--dump=${DUMP}`,
        `--dlq=${DLQ}`,
        `--restore-evidence=${evi}`,
      ]),
    );

  it('matched: nested dump.sha256 等于所选 dump ⇒ 接受并读 nested toc_entries', () => {
    const evi = writeEvidence('evi-match.json', {
      verified: true,
      container: 'loom-restore-drill-x',
      dump: { file: DUMP, sha256: dumpSha, bytes: 9, toc_entries: 42 },
      table_counts: { 'public.event': 3 },
    });
    const { manifest, warnings } = build(evi);
    expect(manifest.backup.dump?.sha256).toBe(dumpSha);
    expect(manifest.backup.restore_evidence?.verified).toBe(false);
    const receipt = manifest.backup.restore_evidence;
    expect(receipt?.kind).toBe('legacy-limited');
    if (receipt?.kind !== 'legacy-limited') throw new Error('expected legacy receipt');
    expect(receipt.reported_verified).toBe(true);
    expect(receipt.toc_entries).toBe(42);
    expect(warnings.some((w) => w.startsWith('restore_evidence_unverified'))).toBe(true);
  });

  it('mismatched: nested dump.sha256 ≠ 所选 dump ⇒ 硬错误并点名两个 hash', () => {
    const other = 'a'.repeat(64);
    const evi = writeEvidence('evi-mismatch.json', {
      verified: true,
      container: 'loom-restore-drill-y',
      dump: { file: '/elsewhere/other.dump', sha256: other },
      table_counts: {},
    });
    let err: Error | null = null;
    try {
      build(evi);
    } catch (e) {
      err = e instanceof Error ? e : new Error('unknown error');
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain(other);
    expect(err?.message).toContain(dumpSha);
  });

  it('missing nested dump.sha256 ⇒ 硬错误（无法绑定，不得凭顶层 verified 冒充）', () => {
    const evi = writeEvidence('evi-nosha.json', {
      verified: true,
      container: 'loom-restore-drill-z',
      table_counts: {},
    });
    expect(() => build(evi)).toThrow(/dump\.sha256/);
  });
});

function migrationFixture() {
  const capture = emptyCapture();
  return buildMigrationManifest(capture, classifyMigrationCapture(capture), {
    tool_version: 'offline',
    git_sha: null,
    app_image: null,
    worker_image: null,
    migration_files: 1,
    redaction: { applied: false, fields: [] },
  });
}
const HASH = 'b'.repeat(64),
  IMAGE = `sha256:${'c'.repeat(64)}`;
const TIME = '2026-10-09T00:00:00.000Z';
function tableFixture(): TableMetadata {
  return {
    schema: 'tlp_dbos',
    name: 'workflow\n"检查',
    kind: 'r',
    persistence: 'p',
    partition: false,
    partition_bound: null,
    parents: [],
    columns: [
      {
        name: 'checkpoint',
        type: { schema: 'pg_catalog', name: 'text' },
        type_chain: [
          {
            schema: 'pg_catalog',
            name: 'text',
            kind: 'builtin',
            enum_labels: [],
            domain_not_null: false,
            modifier: -1,
          },
        ],
        modifier: -1,
        dimensions: 0,
        collation: { schema: 'pg_catalog', name: 'default' },
      },
    ],
  };
}
function digestFixture() {
  const digest = createTableDigest(tableFixture());
  digest.update(`${HASH}\n${HASH}\n${HASH}\n`);
  return digest.finish();
}
function inventoryFixture(): DatabaseManifest {
  return {
    algorithm: CONTENT_ALGORITHM,
    encoding: 'UTF8',
    server_version: '16.14',
    extensions: [
      { name: 'plpgsql', version: '1.0' },
      { name: 'vector', version: '0.8.2' },
    ],
    schemas: ['empty\n检查', 'pgboss', 'public', 'tlp_dbos'],
    tables: [{ ...tableFixture(), ...digestFixture() }],
    sequences: [
      {
        schema: 'public',
        name: 'never-called',
        type: { schema: 'pg_catalog', name: 'int8' },
        start: '1',
        increment: '1',
        min: '1',
        max: '9223372036854775807',
        cache: '32',
        cycle: false,
        owner: null,
        last_value: '9007199254741001',
        is_called: false,
      },
    ],
  };
}
function sourceFixture(directory: string): SourceManifest {
  const database = {
    cluster: '9007199254741001',
    database_oid: '16384',
    database: 'loom',
    server_version: '16.14',
    server_started_at: TIME,
    in_recovery: false,
    server_address: null,
    server_port: null,
  };
  const evidence = {
    format: 'loom-maintenance-boundary',
    version: 1,
    basis: 'external-maintenance-boundary',
    owner: 'parent',
    window: 'fixture',
    established_at: TIME,
    held_until_explicit_release: true,
    source: database,
    source_revision: 'a'.repeat(40),
    app_image: IMAGE,
    worker_image: IMAGE,
    restart_admission_control: 'enforced',
    other_clients_control: 'enforced',
    background_writers_control: 'enforced',
    writers: [{ kind: 'external', name: 'fixture-worker', control: 'enforced' }],
  };
  const quiescencePath = join(directory, 'quiescence.json'),
    dumpPath = join(directory, 'fixture.dump');
  writeFileSync(quiescencePath, JSON.stringify(evidence));
  writeFileSync(dumpPath, 'offline dump bytes');
  return parseSourceManifest({
    format: 'loom-db-source',
    version: 2,
    helper_revision: 'a'.repeat(40),
    source: database,
    source_image: IMAGE,
    client_versions: {
      psql: 'psql (PostgreSQL) 16.14',
      pg_dump: 'pg_dump (PostgreSQL) 16.14',
      pg_restore: 'pg_restore (PostgreSQL) 16.14',
    },
    snapshot: '00000003-00000012-1',
    started_at: TIME,
    finished_at: TIME,
    quiescence: {
      artifact: artifactIdentity(quiescencePath),
      evidence,
      assurance: 'operator-attested-with-observations',
      observations: [0, 1].map(() => ({
        at: TIME,
        sessions: 'no-unowned-clients',
        prepared_transactions: 'none',
        containers: 'stopped',
      })),
    },
    dump: artifactIdentity(dumpPath),
    toc_entries: 1,
    inventory: inventoryFixture(),
    companions: {
      basis: 'external-maintenance-boundary',
      dlq: { file: '/offline/dlq', sha256: HASH, bytes: '2' },
      migration: { file: '/offline/migration', sha256: HASH, bytes: '2' },
    },
  });
}
function receiptFixture(source: SourceManifest, sourceManifest: string): CurrentRestoreReceipt {
  return {
    format: 'loom-restore-drill',
    version: 2,
    kind: 'verified',
    verified: true,
    level: 'database-content-parity',
    started_at: TIME,
    finished_at: TIME,
    dump: source.dump,
    source_manifest: artifactIdentity(sourceManifest),
    source,
    restored: structuredClone(source.inventory),
    quiescence: source.quiescence,
    scratch: { image: IMAGE, container: 'offline-scratch', retained: false },
    errors: [],
    phases: [
      'preflight',
      'staging',
      'bindings',
      'start',
      'toc',
      'restore',
      'inspection',
      'comparison',
      'cleanup',
    ].map((phase) => ({
      phase: z
        .enum([
          'preflight',
          'staging',
          'bindings',
          'start',
          'toc',
          'restore',
          'inspection',
          'comparison',
          'cleanup',
        ])
        .parse(phase),
      kind: 'ok',
    })),
    comparison: compareDatabaseManifests({ source: source.inventory, restored: source.inventory }),
  };
}

describe('full logical parity boundaries', () => {
  it.each([
    'missing schema',
    'extra schema',
    'missing table',
    'extra table',
    'same count changed content',
    'column metadata',
    'parent membership',
    'missing sequence',
    'extra sequence',
    'is_called',
    'sequence precision',
    'enum labels',
  ])('%s fails bidirectional equality', (change) => {
    const source = inventoryFixture(),
      restored = structuredClone(source);
    switch (change) {
      case 'missing schema':
        restored.schemas.shift();
        break;
      case 'extra schema':
        restored.schemas.push('extra');
        break;
      case 'missing table':
        restored.tables = [];
        break;
      case 'extra table':
        restored.tables.push({ ...restored.tables[0], name: 'extra' });
        break;
      case 'same count changed content':
        restored.tables[0].sha256 = 'd'.repeat(64);
        break;
      case 'column metadata':
        restored.tables[0].columns[0].modifier = 1024;
        break;
      case 'parent membership':
        restored.tables[0].partition = true;
        break;
      case 'missing sequence':
        restored.sequences = [];
        break;
      case 'extra sequence':
        restored.sequences.push({ ...restored.sequences[0], name: 'extra' });
        break;
      case 'is_called':
        restored.sequences[0].is_called = true;
        break;
      case 'sequence precision':
        restored.sequences[0].last_value = '9007199254741002';
        break;
      case 'enum labels':
        restored.tables[0].columns[0].type = { schema: 'pgboss', name: 'job_state' };
        restored.tables[0].columns[0].type_chain = [
          {
            schema: 'pgboss',
            name: 'job_state',
            kind: 'enum',
            enum_labels: ['created', 'completed'],
            domain_not_null: false,
            modifier: -1,
          },
        ];
        break;
    }
    expect(compareDatabaseManifests({ source, restored }).kind).toBe('different');
  });
  it('uses tuple identities and preserves bigint counts, duplicate rows and stream chunk boundaries', () => {
    const inventory = inventoryFixture();
    inventory.schemas.push('a', 'a.b');
    inventory.tables.push(
      { ...inventory.tables[0], schema: 'a.b', name: 'c', rows: '9007199254741001' },
      { ...inventory.tables[0], schema: 'a', name: 'b.c' },
    );
    expect(parseDatabaseManifest(inventory).tables).toHaveLength(3);
    const first = createTableDigest(tableFixture()),
      second = createTableDigest(tableFixture());
    first.update(`${HASH}\n${HASH}\n`);
    second.update(HASH.slice(0, 23));
    second.update(`${HASH.slice(23)}\n${HASH}\n`);
    expect(first.finish()).toEqual(second.finish());
    const once = createTableDigest(tableFixture());
    once.update(`${HASH}\n`);
    expect(once.finish().rows).toBe('1');
    const empty = createTableDigest({ ...tableFixture(), columns: [] });
    expect(empty.finish().rows).toBe('0');
  });
  it.each(['truncated', 'invalid', 'unsorted'])('rejects %s stream', (mode) => {
    const digest = createTableDigest(tableFixture());
    expect(() => {
      digest.update(
        mode === 'truncated' ? HASH : mode === 'invalid' ? 'x\n' : `${'f'.repeat(64)}\n${HASH}\n`,
      );
      digest.finish();
    }).toThrow();
  });
  it('quotes Unicode/newlines and every column, FROM ONLY and empty arrays', () => {
    const sql = tableContentSql(tableFixture());
    expect(sql).toContain('FROM ONLY "tlp_dbos"."workflow\n""检查"');
    expect(sql).toContain('json_build_array("checkpoint"::text)::text');
    expect(sql).toContain('ORDER BY h COLLATE "C"');
    expect(quoteIdentifier('a"; DROP SCHEMA x; --')).toBe('"a""; DROP SCHEMA x; --"');
    expect(tableContentSql({ ...tableFixture(), columns: [] })).toContain('json_build_array()');
  });
  it('supports pg-boss enums, recursive domain/array and actual vector; refuses unknown output types', () => {
    const base = {
      oid: '1',
      schema: 'pgboss',
      name: 'job_state',
      kind: 'e',
      category: 'E',
      base: '0',
      element: '0',
      modifier: -1,
      not_null: false,
      extension: null,
      labels: ['created', 'retry', 'active', 'completed', 'cancelled', 'failed'],
      output: { schema: 'pg_catalog', name: 'enum_out' },
    };
    expect(resolveTypeChain('1', [base])[0].enum_labels).toContain('completed');
    const array = {
      ...base,
      oid: '2',
      name: '_job_state',
      output: { schema: 'pg_catalog', name: 'array_out' },
      kind: 'b',
      category: 'A',
      element: '1',
      labels: [],
    };
    const domain = {
      ...base,
      oid: '3',
      name: 'state_list',
      output: { schema: 'pg_catalog', name: 'array_out' },
      kind: 'd',
      category: 'A',
      base: '2',
      labels: [],
    };
    expect(resolveTypeChain('3', [base, array, domain]).map((t) => t.kind)).toEqual([
      'domain',
      'array',
      'enum',
    ]);
    expect(
      resolveTypeChain('1', [
        {
          ...base,
          name: 'vector',
          kind: 'b',
          category: 'U',
          extension: 'vector',
          output: { schema: 'pgboss', name: 'vector_out' },
          labels: [],
        },
      ])[0].kind,
    ).toBe('vector');
    expect(() => resolveTypeChain('1', [{ ...base, kind: 'b', labels: [] }])).toThrow(
      /unsupported/,
    );
  });
  it.each(['duplicate', 'bad count', 'future algorithm', 'foreign'])(
    'rejects %s inventory',
    (kind) => {
      const value = inventoryFixture();
      if (kind === 'duplicate') value.tables.push(value.tables[0]);
      if (kind === 'bad count') value.tables[0].rows = '1e3';
      if (kind === 'foreign') value.tables[0].kind = 'f';
      expect(() =>
        parseDatabaseManifest(
          kind === 'future algorithm' ? { ...value, algorithm: 'future' } : value,
        ),
      ).toThrow();
    },
  );
});

function arrayCatalogFixture(shape: string): TableMetadata {
  const labels: string[] = [];
  const builtin = (oid: string, name: string, category: string) => ({
    oid,
    schema: 'pg_catalog',
    name,
    kind: 'b',
    category,
    base: '0',
    element: '0',
    modifier: -1,
    not_null: false,
    extension: null,
    labels,
    output: { schema: 'pg_catalog', name: `${name}out` },
  });
  const integer = {
    ...builtin('23', 'int4', 'N'),
    output: { schema: 'pg_catalog', name: 'int4out' },
  };
  const text = { ...builtin('25', 'text', 'S'), output: { schema: 'pg_catalog', name: 'textout' } };
  const enumeration = {
    ...text,
    oid: '16384',
    schema: 'restore_fixture',
    name: 'phase',
    kind: 'e',
    category: 'E',
    labels: ['created', '检查', 'completed'],
    output: { schema: 'pg_catalog', name: 'enum_out' },
  };
  const array = (base: typeof text, oid: string, name: string) => ({
    ...base,
    oid,
    name,
    kind: 'b',
    category: 'A',
    base: '0',
    element: base.oid,
    labels: [],
    output: { schema: 'pg_catalog', name: 'array_out' },
  });
  const domain = (base: typeof text, oid: string, name: string) => ({
    ...base,
    oid,
    schema: 'restore_fixture',
    name,
    kind: 'd',
    base: base.oid,
    element: '0',
    not_null: true,
    labels: [],
  });
  const base = shape === 'integer' ? integer : shape === 'enum' ? enumeration : text;
  const baseArray = array(
    base,
    shape === 'integer' ? '1007' : shape === 'enum' ? '16390' : '1009',
    shape === 'integer' ? '_int4' : shape === 'enum' ? '_phase' : '_text',
  );
  const scalarDomain = domain(text, '16385', 'checked_text');
  const domainArray = array(scalarDomain, '16386', '_checked_text');
  const arrayDomain = domain(baseArray, '16387', 'text_matrix');
  const nestedArray = array(arrayDomain, '16388', '_text_matrix');
  const outerDomain = domain(nestedArray, '16389', 'matrices');
  const root =
    shape === 'domain over array'
      ? arrayDomain
      : shape === 'array of domain'
        ? domainArray
        : shape === 'nested'
          ? outerDomain
          : baseArray;
  const chain = resolveTypeChain(root.oid, [
    integer,
    text,
    enumeration,
    baseArray,
    scalarDomain,
    domainArray,
    arrayDomain,
    nestedArray,
    outerDomain,
  ]);
  return {
    ...tableFixture(),
    columns: [
      {
        ...tableFixture().columns[0],
        type: { schema: root.schema, name: root.name },
        type_chain: chain,
      },
    ],
  };
}
function arrayValueDigest(table: TableMetadata, values: Array<string | null>) {
  const digest = createTableDigest(table);
  const rows = values
    .map((value) =>
      createHash('sha256')
        .update(`[${JSON.stringify(value)}]`)
        .digest('hex'),
    )
    .sort();
  for (const row of rows) digest.update(`${row}\n`);
  return digest.finish();
}
function arrayInventory(table: TableMetadata, values: Array<string | null>): DatabaseManifest {
  return { ...inventoryFixture(), tables: [{ ...table, ...arrayValueDigest(table, values) }] };
}
const unicodeArrayElement = '检查🦆\\"\n'.repeat(3000);
const quotedArrayElement = (value: string) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const matrixValue = `[0:1][-2:-1]={{${quotedArrayElement(unicodeArrayElement)},NULL},{"NULL",""}}`;

describe('v2 canonical array catalog and unchanged row bytes', () => {
  it.each(['integer', 'text', 'enum', 'domain over array', 'array of domain', 'nested'])(
    '%s ignores declaration dimension counts only after validating the actual catalog type chain',
    (shape) => {
      const source = arrayCatalogFixture(shape),
        restored = structuredClone(source);
      restored.columns[0].dimensions = 1;
      const values =
        shape === 'integer'
          ? ['[0:1][-2:-1]={{1,NULL},{3,4}}', null, '{}']
          : shape === 'enum'
            ? ['[0:1][-2:-1]={{created,NULL},{检查,completed}}']
            : shape === 'array of domain' || shape === 'domain over array'
              ? [matrixValue.replace(',NULL', ',"present"')]
              : shape === 'nested'
                ? ['{"[0:1][-2:-1]={{a,b},{c,d}}"}']
                : [matrixValue, null, '{}', '{"NULL"}'];
      for (const declared of [0, 1, 2, 6]) {
        restored.columns[0].dimensions = declared;
        expect(canonicalTableMetadata(restored).columns[0].dimensions).toBe(0);
        for (const rows of [[], values]) {
          expect(arrayValueDigest(restored, rows)).toEqual(arrayValueDigest(source, rows));
          expect(
            compareDatabaseManifests({
              source: arrayInventory(source, rows),
              restored: arrayInventory(restored, rows),
            }).kind,
          ).toBe('equal');
        }
      }
      expect(source.columns[0].dimensions).toBe(0);
      expect(restored.columns[0].dimensions).toBe(6);
      expect(canonicalTableMetadata(restored).columns[0].type_chain).toEqual(
        source.columns[0].type_chain,
      );
      expect(tableContentSql(restored)).toContain('"checkpoint"::text');
    },
  );
  it.each([
    'dimensions',
    'bounds',
    'order',
    'content',
    'null element',
    'null array',
    'empty array',
  ])('rejects changed actual value %s at the same row count', (change) => {
    const source = arrayCatalogFixture('text');
    const modified =
      change === 'dimensions'
        ? `{${quotedArrayElement(unicodeArrayElement)},NULL,"NULL",""}`
        : change === 'bounds'
          ? matrixValue.replace('[0:1][-2:-1]', '[1:2][1:2]')
          : change === 'order'
            ? `[0:1][-2:-1]={{NULL,${quotedArrayElement(unicodeArrayElement)}},{"NULL",""}}`
            : change === 'content'
              ? matrixValue.replace('检查', '改变')
              : change === 'null element'
                ? matrixValue.replace(',NULL', ',"NULL"')
                : change === 'null array'
                  ? null
                  : '{}';
    const before = arrayInventory(source, [matrixValue]),
      after = arrayInventory(source, [modified]);
    expect(after.tables[0].rows).toBe(before.tables[0].rows);
    expect(after.tables[0].sha256).not.toBe(before.tables[0].sha256);
    expect(compareDatabaseManifests({ source: before, restored: after }).kind).toBe('different');
  });
  it.each([
    'element type',
    'domain identity',
    'domain not null',
    'domain modifier',
    'domain removal',
    'enum labels',
    'column modifier',
    'collation',
  ])('rejects %s changes even with identical row text', (change) => {
    const source = arrayCatalogFixture(change === 'enum labels' ? 'enum' : 'domain over array');
    const restored = structuredClone(source);
    if (change === 'element type')
      restored.columns[0].type_chain[2] = arrayCatalogFixture('integer').columns[0].type_chain[1];
    if (change === 'domain identity') {
      restored.columns[0].type.name = 'other_matrix';
      restored.columns[0].type_chain[0].name = 'other_matrix';
    }
    if (change === 'domain not null') restored.columns[0].type_chain[0].domain_not_null = false;
    if (change === 'domain modifier') restored.columns[0].type_chain[0].modifier = 64;
    if (change === 'domain removal') {
      restored.columns[0].type_chain.shift();
      restored.columns[0].type = {
        schema: restored.columns[0].type_chain[0].schema,
        name: restored.columns[0].type_chain[0].name,
      };
    }
    if (change === 'enum labels') restored.columns[0].type_chain[1].enum_labels.reverse();
    if (change === 'column modifier') restored.columns[0].modifier = 64;
    if (change === 'collation') restored.columns[0].collation = null;
    expect(arrayValueDigest(restored, [])).not.toEqual(arrayValueDigest(source, []));
    expect(
      compareDatabaseManifests({
        source: arrayInventory(source, []),
        restored: arrayInventory(restored, []),
      }).kind,
    ).toBe('different');
  });
  it.each(['dimensions', 'modifier', 'collation', 'type'])(
    'preserves scalar metadata %s in both comparison and digest',
    (change) => {
      const source = tableFixture(),
        restored = structuredClone(source);
      if (change === 'dimensions') restored.columns[0].dimensions = 1;
      if (change === 'modifier') restored.columns[0].modifier = 64;
      if (change === 'collation') restored.columns[0].collation = null;
      if (change === 'type') {
        restored.columns[0].type = { schema: 'pg_catalog', name: 'varchar' };
        restored.columns[0].type_chain[0].name = 'varchar';
      }
      expect(arrayValueDigest(restored, [])).not.toEqual(arrayValueDigest(source, []));
      expect(
        compareDatabaseManifests({
          source: arrayInventory(source, []),
          restored: arrayInventory(restored, []),
        }).kind,
      ).toBe('different');
    },
  );
  it.each(['mismatched root', 'incomplete', 'scalar prefix', 'recursive'])(
    'refuses a malformed %s chain before discarding declaration metadata',
    (change) => {
      const table = arrayCatalogFixture('text');
      if (change === 'mismatched root')
        table.columns[0].type = { schema: 'pg_catalog', name: 'text' };
      if (change === 'incomplete') table.columns[0].type_chain.pop();
      if (change === 'scalar prefix') {
        table.columns[0].type_chain.unshift(tableFixture().columns[0].type_chain[0]);
        table.columns[0].type = { schema: 'pg_catalog', name: 'text' };
      }
      if (change === 'recursive')
        table.columns[0].type_chain.splice(1, 0, table.columns[0].type_chain[0]);
      expect(() => createTableDigest(table)).toThrow();
      expect(() =>
        parseDatabaseManifest({
          ...inventoryFixture(),
          tables: [{ ...table, rows: '0', sha256: HASH }],
        }),
      ).toThrow();
    },
  );
  it('rejects v1 inventories, cross-algorithm comparisons and versioned receipts without reinterpreting them', () => {
    const oldAlgorithm = 'pg16-column-text-sha256-multiset-v1';
    const table = tableFixture();
    const oldHash = createHash('sha256')
      .update(`${oldAlgorithm}\n${stableStringify(table.columns)}\n`)
      .digest('hex');
    expect(createTableDigest(table).finish().sha256).not.toBe(oldHash);
    const oldInventory = inventoryFixture();
    Object.assign(oldInventory, { algorithm: oldAlgorithm });
    expect(() => parseDatabaseManifest(oldInventory)).toThrow(/unsupported content algorithm/);
    expect(() =>
      compareDatabaseManifests({ source: oldInventory, restored: inventoryFixture() }),
    ).toThrow();
    const dir = mkdtempSync(join(TMP, 'v1-'));
    const source = sourceFixture(dir),
      path = join(dir, 'source.json');
    writeFileSync(path, JSON.stringify(source));
    const receipt = receiptFixture(source, path);
    expect(() => parseSourceManifest({ ...source, inventory: oldInventory })).toThrow(
      /unsupported content algorithm/,
    );
    for (const field of ['source', 'restored', 'both']) {
      const oldReceipt = {
        ...receipt,
        source: field === 'restored' ? source : { ...source, inventory: oldInventory },
        restored: field === 'source' ? receipt.restored : oldInventory,
      };
      const before = JSON.stringify(oldReceipt);
      expect(() => parseRestoreReceipt(oldReceipt)).toThrow(/unsupported content algorithm/);
      expect(JSON.stringify(oldReceipt)).toBe(before);
    }
    expect(parseRestoreReceipt({ verified: true })).toMatchObject({
      verified: false,
      reported_verified: true,
      kind: 'legacy-limited',
    });
  });
});

describe('artifact and receipt consumer', () => {
  const directory = mkdtempSync(join(TMP, 'binding-'));
  const source = sourceFixture(directory),
    sourcePath = join(directory, 'source.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const receipt = receiptFixture(source, sourcePath);
  it('validates all exact-byte links and retains complete receipt through manifest assembly', () => {
    const cap = join(directory, 'cap');
    mkdirSync(cap);
    writeFileSync(join(cap, 'latest.json'), JSON.stringify({ manifest_file: 'manifest.json' }));
    writeFileSync(join(cap, 'manifest.json'), JSON.stringify(migrationFixture()));
    const selectedSource = structuredClone(source);
    selectedSource.companions.migration = artifactIdentity(join(cap, 'manifest.json'));
    writeFileSync(sourcePath, JSON.stringify(selectedSource));
    const selectedReceipt = receiptFixture(selectedSource, sourcePath);
    const receiptPath = join(directory, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(selectedReceipt));
    const { manifest } = buildManifest(
      parseCutoverBackupArgs([
        `--capture-dir=${cap}`,
        `--dump=${source.dump.file}`,
        `--source-manifest=${sourcePath}`,
        `--restore-evidence=${receiptPath}`,
        '--require-restore-parity',
      ]),
    );
    expect(manifest.backup.restore_evidence?.kind).toBe('verified');
    expect(manifest.backup.restore_evidence).toMatchObject({
      source: selectedSource,
      restored: selectedSource.inventory,
      comparison: selectedReceipt.comparison,
    });
    writeFileSync(sourcePath, JSON.stringify(source));
  });
  it.each(['dump', 'source', 'quiescence'])('rejects wrong %s hash', (kind) => {
    expect(() =>
      validateArtifactBindings({
        source,
        dump: kind === 'dump' ? { ...source.dump, sha256: HASH } : source.dump,
        receipt,
        sourceArtifact: {
          ...artifactIdentity(sourcePath),
          ...(kind === 'source' ? { sha256: HASH } : {}),
        },
        quiescenceArtifact: {
          ...source.quiescence.artifact,
          ...(kind === 'quiescence' ? { sha256: HASH } : {}),
        },
      }),
    ).toThrow(/binding/);
  });
  it.each(['phase', 'comparison', 'version', 'source', 'assurance'])(
    'rejects forged %s receipt',
    (field) => {
      const forged = structuredClone(receipt);
      if (field === 'phase') forged.phases[0].kind = 'failed';
      if (field === 'comparison' && forged.restored)
        forged.restored.tables[0].sha256 = 'e'.repeat(64);
      if (field === 'source' && forged.source) forged.source.inventory.schemas.push('extra');
      expect(() =>
        parseRestoreReceipt(
          field === 'version'
            ? { ...forged, version: 3 }
            : field === 'assurance'
              ? { ...forged, quiescence: { ...forged.quiescence, assurance: 'unknown' } }
              : forged,
        ),
      ).toThrow();
    },
  );
  it('legacy remains historical and does not satisfy the independent gate; strict presence stays unchanged', () => {
    expect(parseRestoreReceipt({ verified: true })).toMatchObject({
      kind: 'legacy-limited',
      reported_verified: true,
      verified: false,
    });
    expect(
      requiredMissing(parseCutoverBackupArgs(['--strict', '--manifest=x', '--dump=y', '--dlq=z'])),
    ).toEqual([]);
    const cap = join(directory, 'gate-manifest.json');
    writeFileSync(cap, JSON.stringify(migrationFixture()));
    expect(() =>
      buildManifest(parseCutoverBackupArgs([`--manifest=${cap}`, '--require-restore-parity'])),
    ).toThrow(/require-restore-parity/);
  });
  it('serialization safely round-trips arbitrary diagnostics and failed finalization never emits success', () => {
    const out = join(directory, 'failed.json'),
      failed = structuredClone(receipt);
    failed.errors = [{ phase: 'inspection', code: 'offline', message: '"\\\n检查\u0001' }];
    expect(finalizeRestoreEvidence({ receipt: failed, out })).toBe(1);
    expect(parseRestoreReceipt(readJsonArtifact(out).value)).toMatchObject({
      kind: 'failed',
      verified: false,
      errors: failed.errors,
    });
    expect(() => finalizeRestoreEvidence({ receipt: failed, out: directory })).toThrow();
  });
});

// All transport executables below are intercepted, with exit 97 for unknown calls.
// There is deliberately no delegation to Docker, psql, pnpm or any network client.
function offlineTransport(directory: string, mode: string) {
  const source = sourceFixture(directory),
    sourcePath = join(directory, 'source.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const config = {
    mode,
    source,
    sourcePath,
    migration: migrationFixture(),
    rawCatalog: {
      ...source.inventory,
      algorithm: undefined,
      tables: source.inventory.tables.map((t) => ({
        ...t,
        rows: undefined,
        sha256: undefined,
        populated: true,
        columns: t.columns.map((c) => ({ ...c, type_chain: undefined, type_oid: '25' })),
      })),
      sequences: source.inventory.sequences.map((s) => ({
        ...s,
        last_value: undefined,
        is_called: undefined,
      })),
    },
  };
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const program = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8')),args=process.argv.slice(2),tool=path.basename(process.argv[1]);
fs.appendFileSync(${JSON.stringify(join(directory, 'commands.jsonl'))},JSON.stringify({tool,args})+'\\n');
const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v)+'\\n');
const bad=(code=17)=>{process.stderr.write('OFFLINE_INJECTED_'+c.mode+'\\n');process.exit(code);};
const input=fn=>{let b=[];process.stdin.on('data',d=>b.push(d));process.stdin.on('end',()=>fn(Buffer.concat(b)));};
if(tool==='pnpm'||(tool==='node'&&args.some(a=>a.endsWith('/migration-capture.ts')))) {const o=args.find(a=>a.startsWith('--out=')).slice(6);fs.mkdirSync(o,{recursive:true});fs.writeFileSync(path.join(o,'manifest.json'),JSON.stringify(c.migration));fs.writeFileSync(path.join(o,'latest.json'),JSON.stringify({manifest_file:'manifest.json'}));process.exit(0);}
if(tool==='psql') {out(c.mode==='target-mismatch'?{...c.source.source,cluster:'999'}:c.source.source);process.exit(0);}
if(args[0]==='inspect'&&args.length===2){const f=${JSON.stringify(join(directory, 'scratch.json'))};const s=JSON.parse(fs.readFileSync(f));let n=s.inspections||0;s.inspections=n+1;fs.writeFileSync(f,JSON.stringify(s));delete s.inspections;if(c.mode==='wrong-owner')s.Config.Labels={};if(c.mode==='wrong-image')s.Image='sha256:'+'f'.repeat(64);if(c.mode==='wrong-name')s.Name='/someone-else';if(c.mode==='wrong-id')s.Id='f'.repeat(64);if(c.mode==='wrong-db-env')s.Config.Env[2]='POSTGRES_DB=other';if(c.mode==='wrong-volume')s.Mounts[0].Name='other';if(c.mode==='mapping'||(c.mode==='mapping-race'&&n>1))s.NetworkSettings.Ports={'5432/tcp':[{HostIp:'0.0.0.0',HostPort:'15555'}]};if(c.mode==='cleanup-owner'&&(s.identities||0)>=3)s.Config.Labels={};if(c.mode==='storage-race'&&n>1)s.Mounts[0].Name='replaced-volume';if(c.mode==='unexpected-volume')s.HostConfig.Binds=['someone-elses-volume:/data'];out([s]);process.exit(0);}
if(args[0]==='inspect'||args[0]==='image') {if(args.includes('{{json .State}}'))out({Running:c.mode==='writer-running',Restarting:false,Status:'exited'});else {if(c.mode==='replace-input')fs.writeFileSync(c.source.dump.file,'replaced input after staging');out(JSON.stringify(${JSON.stringify(IMAGE)})+'\\n');}process.exit(0);}
if(args.includes('sh')&&args.some(a=>a.includes('df -Pk'))){out('Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 1000000 1 999999 1% /data\\n');process.exit(0);}
if(args[0]==='rm') {if(c.mode==='cleanup')bad();process.exit(0);}
if(args[0]==='run'&&!args.includes('--rm')) {const env=args.filter(a=>a.startsWith('POSTGRES_')),port=args.includes('--publish')?args[args.indexOf('--publish')+1].split(':')[1]:null;const bindings=port?{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:port}]}:{};const s={Id:'c'.repeat(64),Name:'/'+args[args.indexOf('--name')+1],Image:${JSON.stringify(IMAGE)},Config:{Env:env,Labels:{'loom.restore-drill.attempt':args[args.indexOf('--label')+1].split('=')[1]},Volumes:{'/var/lib/postgresql/data':{}}},State:{Running:true,Restarting:false},HostConfig:{NetworkMode:port?'bridge':'none',Binds:null,PortBindings:bindings},NetworkSettings:{Ports:bindings},Mounts:[{Type:'volume',Name:'offline-anonymous-volume',Destination:'/var/lib/postgresql/data'}]};fs.writeFileSync(${JSON.stringify(join(directory, 'scratch.json'))},JSON.stringify(s));if(c.mode==='ambiguous-create'||c.mode==='collision')bad();if(c.mode==='ambiguous-signal')process.kill(process.pid,'SIGTERM');out(c.mode==='unknown-id'?'offline-container':s.Id);process.exit(0);}
if(args[0]==='exec') {
let i=1;const env={};
while(args[i]?.startsWith('-')) {if(args[i]==='-i')i++;else if(args[i]==='-e'){const value=args[i+1],separator=value.indexOf('=');if(separator<1)bad(97);env[value.slice(0,separator)]=value.slice(separator+1);i+=2;}else bad(97);}
const scratch=args[i]==='c'.repeat(64),client=args[i+1],clientArgs=args.slice(i+2);
if(!scratch&&Object.hasOwn(env,'PGPASSWORD'))bad(97);
if(scratch&&((client==='psql'&&clientArgs.includes('-h'))||(client==='pg_restore'&&clientArgs.includes('-d')))) {
const s=JSON.parse(fs.readFileSync(${JSON.stringify(join(directory, 'scratch.json'))})),password=s.Config.Env.find(value=>value.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length);
if(!password||env.PGPASSWORD!==password||(c.mode==='scratch-auth-restore'&&client==='pg_restore')){process.stderr.write('fe_sendauth: no password supplied or password authentication failed\\n');bad(18);}
}
}
if(args.includes('--version')) {out('psql (PostgreSQL) 16.14\\n');process.exit(0);}
if(args.includes('pg_dump')) {if(c.mode==='dump')bad();out('offline dump bytes');process.exit(0);}
if(args.includes('pg_restore')) {input(b=>{fs.appendFileSync(${JSON.stringify(join(directory, 'bytes.jsonl'))},JSON.stringify({sha:crypto.createHash('sha256').update(b).digest('hex')})+'\\n');if(args.includes('-l')){if(c.mode==='toc')bad();out('1; 1 1 TABLE fixture offline\\n');}else if(c.mode==='restore')bad();});}
else if(args.includes('psql')) {
const sql=args.includes('-c')?args[args.indexOf('-c')+1]:undefined;
if(!sql){let text='';process.stdin.on('data',b=>{text+=b;if(text.includes('pg_export_snapshot')){text='';if(c.mode==='keeper-export')bad();out({snapshot:c.source.snapshot,pid:123});if(c.mode==='keeper-closed')process.exit(0);}else if(text.includes('ROLLBACK')){const marker=text.match(/SELECT '(loom_keeper_closed_[a-f0-9-]+)'/);if(marker&&c.mode!=='keeper-no-ack')out(marker[1]+'\\n');process.exit(0);}});}
else if(sql==='select 1') {out('1\\n');}
else if(sql.includes('pg_control_system')){if(args.includes('c'.repeat(64))){const f=${JSON.stringify(join(directory, 'scratch.json'))},s=JSON.parse(fs.readFileSync(f));s.identities=(s.identities||0)+1;fs.writeFileSync(f,JSON.stringify(s));out({...c.source.source,cluster:c.mode==='same-cluster'?c.source.source.cluster:'8007199254741001',database:args[args.indexOf('-d')+1],database_oid:c.mode==='identity-race'&&s.identities>1?'999':'16385',server_started_at:c.mode==='restart-race'&&s.identities>2?'2026-10-09T02:00:00.000Z':c.source.source.server_started_at,in_recovery:c.mode==='recovery',server_address:'127.0.0.1',server_port:5432});}else out(c.source.source);}
else if(sql.includes('pg_stat_activity')){out({visible:c.mode!=='visibility',prepared:c.mode==='prepared'?'1':'0',unowned:c.mode==='unknown-client'?'1':'0'});}
else if(sql.includes("'tables'")&&sql.includes("'schemas'")){if(c.mode==='inventory')bad();out(c.rawCatalog);}
else if(sql.includes("'labels'")){out([{oid:'25',schema:'pg_catalog',name:'text',kind:'b',category:'S',base:'0',element:'0',modifier:-1,not_null:false,extension:null,labels:[],output:{schema:'pg_catalog',name:'textout'}}]);}
else if(sql.includes('COPY (SELECT h')){if(c.mode==='table-stream')bad();out(c.mode==='stream-invalid'?'bad\\n':${JSON.stringify(`${HASH}\n${HASH}\n${HASH}\n`)});}
else if(sql.includes("'last_value'")){if(c.mode==='sequence')bad();out({last_value:'9007199254741001',is_called:false});}
else if(sql.includes('pgboss.job')){out('[]\\n');}
else bad(97);
} else bad(97);
`;
  for (const name of ['docker', 'psql', 'pnpm', 'node']) {
    const file = join(bin, name);
    writeFileSync(file, program);
    const chmod = spawnSync('/bin/chmod', ['u+x', file]);
    if (chmod.status !== 0) throw new Error('offline executable setup failed');
  }
  const driverPath = join(directory, 'postgres.mjs'),
    preload = join(directory, 'intercept.mjs');
  writeFileSync(
    driverPath,
    `
import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));
const log=args=>fs.appendFileSync(${JSON.stringify(join(directory, 'commands.jsonl'))},JSON.stringify({tool:'postgres',args:args.map(String)})+'\\n');
log(['import']);
export default function postgres(options){
log(['create']);
if(options.max!==1||options.prepare!==false||options.fetch_types!==false||options.connection.default_transaction_read_only!==true||options.connection.statement_timeout!==10000||options.user!=='offline'||options.database!=='loom'||options.host!=='offline'||options.port!==5432||options.password()!=='offline')throw Error('offline identity options violated');
return {
begin:async (mode,fn)=>{log(['begin',mode]);if(mode!=='isolation level repeatable read read only')throw Error('not readonly');if(c.mode==='driver-connect')throw Error('SECRET postgres://offline:offline@offline/loom');if(c.mode==='driver-timeout')return new Promise(()=>{});if(c.mode==='driver-interrupt'){queueMicrotask(()=>process.kill(process.pid,'SIGTERM'));return new Promise(()=>{});}return fn({unsafe:sql=>({values:async()=>{log(['query',sql]);if(c.mode==='driver-query')throw Error('SECRET query error');return [[c.mode==='driver-json'?{}:c.mode==='target-mismatch'?{...c.source.source,cluster:'999'}:c.source.source]];}})});},
end:async options=>{log(['end',options.timeout]);if(c.mode==='driver-close')throw Error('SECRET close error');if(c.mode==='driver-close-timeout')return new Promise(()=>{});}
};
}
`,
  );
  writeFileSync(
    preload,
    `
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import net from 'node:net';import tls from 'node:tls';import dgram from 'node:dgram';import cp from 'node:child_process';
const trap=()=>{throw Error('OFFLINE network/listener trap');};
net.connect=trap;net.createConnection=trap;net.Socket.prototype.connect=trap;net.Server.prototype.listen=trap;tls.connect=trap;dgram.createSocket=trap;syncBuiltinESMExports();
if(process.env.YUK1359_IMPORT_ONLY==='1'){for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=trap;syncBuiltinESMExports();}
registerHooks({resolve(specifier,context,next){return specifier==='postgres'?{url:${JSON.stringify(`file://${driverPath}`)},shortCircuit:true}:next(specifier,context);}});
`,
  );
  return { source, sourcePath, bin, preload };
}
function offlineCli(
  _directory: string,
  transport: ReturnType<typeof offlineTransport>,
  args: string[],
) {
  return spawnSync(
    process.execPath,
    ['--import', transport.preload, '--import', 'tsx', 'scripts/cutover-backup.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: `${transport.bin}:${process.env.PATH}`,
        NODE_OPTIONS: `--import=${transport.preload}`,
        PGHOST: 'forbidden-fallback',
        PGDATABASE: 'forbidden-fallback',
        PGUSER: 'forbidden-fallback',
        PGPASSWORD: 'forbidden-fallback',
        DATABASE_URL: 'postgres://forbidden/forbidden',
        HOME: process.env.HOME,
        npm_config_manage_package_manager_versions: 'false',
        npm_config_verify_deps_before_run: 'false',
        pnpm_config_verify_deps_before_run: 'false',
      },
    },
  );
}
describe('real CLI through fully intercepted transport', () => {
  it.each(['inventory', 'table-stream', 'sequence', 'toc', 'stream-invalid', 'restore', 'cleanup'])(
    '%s failure emits JSON, false and nonzero',
    (mode) => {
      const directory = mkdtempSync(join(TMP, `transport-${mode}-`)),
        transport = offlineTransport(directory, mode),
        out = join(directory, 'receipt.json');
      const result = offlineCli(directory, transport, [
        '--operation=restore-drill',
        `--dump=${transport.source.dump.file}`,
        `--source-manifest=${transport.sourcePath}`,
        `--out=${out}`,
      ]);
      expect(result.status, result.stderr).toBe(1);
      const receipt = parseRestoreReceipt(readJsonArtifact(out).value);
      expect(receipt).toMatchObject({ kind: 'failed', verified: false });
      if (receipt.kind === 'legacy-limited') throw new Error('unexpected legacy');
      expect(
        receipt.errors.some(
          (e) => e.phase === mode || (mode === 'stream-invalid' && e.phase === 'table-stream'),
        ),
      ).toBe(true);
      if (mode === 'inventory')
        expect(receipt.errors).toContainEqual(
          expect.objectContaining({ phase: 'inventory', exitCode: 17 }),
        );
    },
  );
  it('passes a complete restore and restores staged bytes after the original input is replaced', () => {
    const directory = mkdtempSync(join(TMP, 'transport-success-')),
      transport = offlineTransport(directory, 'replace-input'),
      out = join(directory, 'receipt.json');
    const result = offlineCli(directory, transport, [
      '--operation=restore-drill',
      `--dump=${transport.source.dump.file}`,
      `--source-manifest=${transport.sourcePath}`,
      `--out=${out}`,
    ]);
    expect(result.status, result.stderr + (existsSync(out) ? readFileSync(out, 'utf8') : '')).toBe(
      0,
    );
    expect(parseRestoreReceipt(readJsonArtifact(out).value)).toMatchObject({
      kind: 'verified',
      verified: true,
    });
    for (const line of readFileSync(join(directory, 'bytes.jsonl'), 'utf8').trim().split('\n'))
      expect(JSON.parse(line).sha).toBe(transport.source.dump.sha256);
    expect(readFileSync(transport.source.dump.file, 'utf8')).toBe('replaced input after staging');
  });
  it.each([
    'keeper-export',
    'keeper-closed',
    'dump',
    'target-mismatch',
    'prepared',
    'unknown-client',
    'visibility',
    'writer-running',
    'keeper-no-ack',
  ])('capture refuses %s and publishes no ready manifest', (mode) => {
    const directory = mkdtempSync(join(TMP, `capture-${mode}-`)),
      transport = offlineTransport(directory, mode),
      out = join(directory, 'capture');
    if (mode === 'writer-running') {
      const evidence = transport.source.quiescence.evidence;
      evidence.writers = [{ kind: 'container', id: 'offline-worker', state: 'stopped' }];
      writeFileSync(transport.source.quiescence.artifact.file, JSON.stringify(evidence));
    }
    const result = offlineCli(directory, transport, [
      '--operation=capture-parity',
      `--out=${out}`,
      '--target=postgres://offline:offline@offline/loom',
      `--quiescence-evidence=${transport.source.quiescence.artifact.file}`,
      '--container=offline-source',
    ]);
    expect(result.status, result.stderr).toBe(1);
    const files = requireDirectory(out);
    expect(files.some((file) => file.endsWith('source-manifest.json'))).toBe(false);
    expect(files.some((file) => file.endsWith('capture-failed.json'))).toBe(true);
  });
  it('keeps keeper open through dump, source readers and companion capture before sealing', () => {
    const directory = mkdtempSync(join(TMP, 'capture-pass-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'capture');
    const result = offlineCli(directory, transport, [
      '--operation=capture-parity',
      `--out=${out}`,
      '--target=postgres://offline:offline@offline/loom',
      `--quiescence-evidence=${transport.source.quiescence.artifact.file}`,
      '--container=offline-source',
      '--strict',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const resultJson = z.object({ source_manifest: z.string() }).parse(JSON.parse(result.stdout));
    expect(
      parseSourceManifest(readJsonArtifact(resultJson.source_manifest).value).companions.basis,
    ).toBe('external-maintenance-boundary');
    const sourceExecs = transportCommands(directory).filter((c) => c.args[0] === 'exec');
    expect(sourceExecs.length).toBeGreaterThan(5);
    for (const command of sourceExecs) {
      expect(command.args).toContain('offline-source');
      expect(command.args.some((arg) => arg.startsWith('PGPASSWORD='))).toBe(false);
    }
  });
  it('missing source and malformed JSON fail before any transport; existing receipt requires explicit overwrite', () => {
    const directory = mkdtempSync(join(TMP, 'preflight-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'receipt.json');
    let result = offlineCli(directory, transport, [
      '--operation=restore-drill',
      `--dump=${transport.source.dump.file}`,
      `--out=${out}`,
    ]);
    expect(result.status).toBe(1);
    expect(existsSync(join(directory, 'commands.jsonl'))).toBe(false);
    writeFileSync(out, JSON.stringify({ verified: true }));
    result = offlineCli(directory, transport, [
      '--operation=restore-drill',
      `--dump=${transport.source.dump.file}`,
      `--out=${out}`,
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(readFileSync(out, 'utf8')).verified).toBe(true);
    expect(requireDirectory(directory).some((file) => file.includes('.failed-attempt-'))).toBe(
      true,
    );
    writeFileSync(transport.sourcePath, 'invalid JSON');
    result = offlineCli(directory, transport, [
      '--operation=restore-drill',
      `--dump=${transport.source.dump.file}`,
      `--source-manifest=${transport.sourcePath}`,
      `--out=${out}`,
      '--overwrite',
    ]);
    expect(result.status).toBe(1);
    expect(parseRestoreReceipt(readJsonArtifact(out).value).verified).toBe(false);
  });
});
function requireDirectory(directory: string): string[] {
  return readdirSync(directory, { recursive: true }).map((file) => String(file));
}

it.each([
  'wrong dump',
  'wrong quiescence',
  'missing quiescence',
  'missing source',
  'unknown maintenance',
])('real CLI rejects %s before scratch restore', (mode) => {
  const directory = mkdtempSync(join(TMP, 'reject-bindings-')),
    transport = offlineTransport(directory, 'success'),
    out = join(directory, 'receipt.json');
  if (mode === 'wrong dump') writeFileSync(transport.source.dump.file, 'wrong bytes');
  if (mode === 'wrong quiescence') writeFileSync(transport.source.quiescence.artifact.file, '{}');
  if (mode === 'missing quiescence') rmSync(transport.source.quiescence.artifact.file);
  if (mode === 'missing source') rmSync(transport.sourcePath);
  if (mode === 'unknown maintenance') {
    const value = transport.source;
    writeFileSync(
      transport.sourcePath,
      JSON.stringify({
        ...value,
        quiescence: {
          ...value.quiescence,
          evidence: { ...value.quiescence.evidence, restart_admission_control: 'unknown' },
        },
      }),
    );
  }
  const result = offlineCli(directory, transport, [
    '--operation=restore-drill',
    `--dump=${transport.source.dump.file}`,
    `--source-manifest=${transport.sourcePath}`,
    `--out=${out}`,
  ]);
  expect(result.status).toBe(1);
  expect(parseRestoreReceipt(readJsonArtifact(out).value).verified).toBe(false);
  expect(existsSync(join(directory, 'commands.jsonl'))).toBe(false);
});
it('list-only never emits parity and restore-only remains limited; inner TOC exit cannot be masked', () => {
  for (const mode of ['success', 'toc']) {
    const directory = mkdtempSync(join(TMP, 'limited-')),
      transport = offlineTransport(directory, mode),
      out = join(directory, 'receipt.json');
    const base = [
      '--operation=restore-drill',
      `--dump=${transport.source.dump.file}`,
      `--out=${out}`,
      `--image=${IMAGE}`,
    ];
    const listing = offlineCli(directory, transport, [...base, '--list-only']);
    expect(listing.status).toBe(mode === 'success' ? 0 : 1);
    if (mode === 'success') expect(existsSync(out)).toBe(false);
    else expect(parseRestoreReceipt(readJsonArtifact(out).value).verified).toBe(false);
    const restoration = offlineCli(directory, transport, [
      ...base,
      '--restore-only',
      '--overwrite',
    ]);
    expect(restoration.status).toBe(mode === 'success' ? 0 : 1);
    expect(parseRestoreReceipt(readJsonArtifact(out).value)).toMatchObject({
      verified: false,
      kind: mode === 'success' ? 'sql-restore-only' : 'failed',
    });
  }
});
it('complete failure receipts are retained by core builder and failed comparisons cannot pass capture-only assembly', () => {
  const directory = mkdtempSync(join(TMP, 'failed-gate-')),
    source = sourceFixture(directory),
    sourcePath = join(directory, 'source.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const receipt = receiptFixture(source, sourcePath);
  if (!receipt.restored) throw new Error('missing fixture');
  receipt.restored.tables[0].sha256 = 'f'.repeat(64);
  const out = join(directory, 'failed.json');
  expect(finalizeRestoreEvidence({ receipt, out })).toBe(1);
  const migration = join(directory, 'migration.json');
  writeFileSync(migration, JSON.stringify(migrationFixture()));
  expect(() =>
    buildManifest(
      parseCutoverBackupArgs([
        `--manifest=${migration}`,
        `--dump=${source.dump.file}`,
        `--restore-evidence=${out}`,
      ]),
    ),
  ).toThrow(/recorded restore failure/);
});

it('compares schema/table/sequence/extension sets without requiring their input order', () => {
  const source = inventoryFixture(),
    restored = structuredClone(source);
  restored.schemas.reverse();
  restored.tables.reverse();
  restored.sequences.reverse();
  restored.extensions.reverse();
  expect(compareDatabaseManifests({ source, restored }).kind).toBe('equal');
});

function hostEvidence(directory: string, source: SourceManifest): QuiescenceEvidence {
  const worker = join(directory, 'fixture-worker.mjs');
  writeFileSync(
    worker,
    `// Offline artifact with nested checkpoint data\nexport const checkpoint=${JSON.stringify({ completed: ['once'], pending: { payload: '检查\n"\\'.repeat(1024) }, held: ['unknown-commit'] })};\n`,
  );
  const previous = source.quiescence.evidence;
  const {
    format,
    basis,
    owner,
    window,
    established_at,
    held_until_explicit_release,
    source: identity,
    source_revision,
    restart_admission_control,
    other_clients_control,
    background_writers_control,
    writers,
  } = previous;
  return {
    format,
    version: 2,
    basis,
    owner,
    window,
    established_at,
    held_until_explicit_release,
    source: identity,
    source_revision,
    restart_admission_control,
    other_clients_control,
    background_writers_control,
    writers,
    execution: {
      kind: 'host-node-v1',
      app: { kind: 'absent' },
      runtime: {
        kind: 'node',
        version: process.version,
        artifact: artifactIdentity(process.execPath),
      },
      worker: { name: 'fixture-worker', artifact: artifactIdentity(worker) },
    },
  };
}
function useHostEvidence(
  transport: ReturnType<typeof offlineTransport>,
  evidence: QuiescenceEvidence,
) {
  writeFileSync(transport.source.quiescence.artifact.file, JSON.stringify(evidence));
  transport.source.quiescence.evidence = evidence;
  transport.source.quiescence.artifact = artifactIdentity(
    transport.source.quiescence.artifact.file,
  );
  writeFileSync(transport.sourcePath, JSON.stringify(transport.source));
}
const loopbackArgs = [
  '--keep',
  '--scratch-loopback-port=15555',
  '--scratch-database=test_fork_20261009',
];
function restoreArgs(transport: ReturnType<typeof offlineTransport>, out: string) {
  return [
    '--operation=restore-drill',
    `--dump=${transport.source.dump.file}`,
    `--source-manifest=${transport.sourcePath}`,
    `--out=${out}`,
  ];
}
function transportCommands(directory: string) {
  const path = join(directory, 'commands.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) =>
          z.object({ tool: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)),
        )
    : [];
}

describe('scratch client authentication through intercepted Docker exec', () => {
  it.each(['default', 'retained-loopback', 'sql-only'])(
    '%s supplies the isolated password to every connecting scratch client',
    (mode) => {
      const directory = mkdtempSync(join(TMP, 'scratch-auth-')),
        transport = offlineTransport(directory, 'success'),
        out = join(directory, 'receipt.json');
      const args =
        mode === 'sql-only'
          ? [
              '--operation=restore-drill',
              `--dump=${transport.source.dump.file}`,
              `--out=${out}`,
              `--image=${IMAGE}`,
              '--restore-only',
            ]
          : [...restoreArgs(transport, out), ...(mode === 'retained-loopback' ? loopbackArgs : [])];
      const result = offlineCli(directory, transport, args);
      expect(result.status, result.stderr).toBe(0);
      expect(parseRestoreReceipt(readJsonArtifact(out).value)).toMatchObject({
        kind: mode === 'sql-only' ? 'sql-restore-only' : 'verified',
        verified: mode !== 'sql-only',
      });
      const clients = transportCommands(directory).filter(
        (c) =>
          c.args[0] === 'exec' &&
          (c.args.includes('psql') || (c.args.includes('pg_restore') && c.args.includes('-d'))),
      );
      expect(clients.length).toBeGreaterThan(3);
      expect(clients.filter((c) => c.args.includes('pg_restore'))).toHaveLength(1);
      for (const client of clients) {
        expect(client.args.slice(0, 5)).toEqual([
          'exec',
          '-i',
          '-e',
          'PGPASSWORD=loom',
          'c'.repeat(64),
        ]);
        if (client.args.includes('psql')) {
          expect(
            client.args.slice(client.args.indexOf('-h'), client.args.indexOf('-h') + 2),
          ).toEqual(['-h', '127.0.0.1']);
        }
      }
      const commands = transportCommands(directory);
      expect(commands.some((c) => c.args[0] === 'rm')).toBe(mode !== 'retained-loopback');
      if (mode === 'retained-loopback')
        expect(clients.at(-1)?.args.some((arg) => arg.includes('pg_control_system'))).toBe(true);
    },
  );
  it.each(['psql', 'pg_restore'])(
    'the fake rejects missing or wrong %s exec passwords despite inherited credentials',
    (client) => {
      const directory = mkdtempSync(join(TMP, 'scratch-auth-reject-')),
        transport = offlineTransport(directory, 'success'),
        out = join(directory, 'receipt.json');
      expect(
        offlineCli(directory, transport, [...restoreArgs(transport, out), ...loopbackArgs]).status,
      ).toBe(0);
      const clientArgs =
        client === 'psql'
          ? ['-U', 'loom', '-d', 'test_fork_20261009', '-h', '127.0.0.1', '-c', 'select 1']
          : ['-U', 'loom', '-d', 'test_fork_20261009'];
      for (const environment of [
        [],
        ['-e', 'PGPASSWORD=wrong'],
        ['-e', 'POSTGRES_PASSWORD=loom'],
      ]) {
        const result = spawnSync(
          join(transport.bin, 'docker'),
          ['exec', '-i', ...environment, 'c'.repeat(64), client, ...clientArgs],
          { encoding: 'utf8', timeout: 1000, input: '', env: { PGPASSWORD: 'loom' } },
        );
        expect(result.status, result.stderr).toBe(18);
        expect(result.stderr).toContain('password authentication failed');
      }
      const source = spawnSync(
        join(transport.bin, 'docker'),
        ['exec', '-i', '-e', 'PGPASSWORD=loom', 'offline-source', client, ...clientArgs],
        { encoding: 'utf8', timeout: 1000, input: '' },
      );
      expect(source.status, source.stderr).toBe(97);
    },
  );
  it.each([false, true])(
    'restore authentication failure remains fail-closed with keep=%s',
    (keep) => {
      const directory = mkdtempSync(join(TMP, 'scratch-auth-failure-')),
        transport = offlineTransport(directory, 'scratch-auth-restore'),
        out = join(directory, 'receipt.json');
      const result = offlineCli(directory, transport, [
        ...restoreArgs(transport, out),
        ...(keep ? loopbackArgs : []),
      ]);
      expect(result.status, result.stderr).toBe(1);
      const receipt = parseRestoreReceipt(readJsonArtifact(out).value);
      expect(receipt).toMatchObject({
        kind: 'failed',
        verified: false,
        scratch: { retained: keep },
        errors: [expect.objectContaining({ phase: 'restore', exitCode: 18 })],
      });
      if (receipt.kind !== 'failed') throw new Error('expected failed receipt');
      expect(receipt.scratch.reopen).toBeUndefined();
      const commands = transportCommands(directory);
      expect(commands.some((c) => c.args[0] === 'rm')).toBe(!keep);
      if (!keep) expect(commands.at(-1)?.args).toEqual(['rm', '-f', '-v', 'c'.repeat(64)]);
    },
  );
});

describe('retained scratch public options and ownership', () => {
  it.each([
    ['--scratch-loopback-port=15555'],
    ['--scratch-database=test_fork_1'],
    ['--scratch-loopback-port', '15555', '--scratch-database=test_fork_1'],
    ['--scratch-loopback-port=', '--scratch-database=test_fork_1'],
    ['--scratch-loopback-port=1023', '--scratch-database=test_fork_1'],
    ['--scratch-loopback-port=65536', '--scratch-database=test_fork_1'],
    ['--scratch-loopback-port=1e4', '--scratch-database=test_fork_1'],
    ['--scratch-loopback-port=015555', '--scratch-database=test_fork_1'],
    ['--scratch-loopback-port=15555', '--scratch-database=loom'],
    ['--scratch-loopback-port=15555', '--scratch-database=test_fork_1;DROP'],
    [...loopbackArgs, '--scratch-loopback-port=15555'],
    [...loopbackArgs, '--scratch-database=test_fork_2'],
    [...loopbackArgs, '--scratch-database'],
    [...loopbackArgs, '--restore-only'],
    [...loopbackArgs, '--list-only'],
  ])('rejects malformed/limited access %j before transports', (...args: string[]) => {
    const directory = mkdtempSync(join(TMP, 'scratch-options-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'receipt.json');
    const result = offlineCli(directory, transport, [
      ...restoreArgs(transport, out),
      '--keep',
      ...args,
    ]);
    expect(result.status, result.stderr).toBe(1);
    expect(parseRestoreReceipt(readJsonArtifact(out).value).verified).toBe(false);
    expect(transportCommands(directory)).toEqual([]);
  });
  it('requires keep, rejects scratch flags in capture, and accepts only the bounded port endpoints', () => {
    expect(() =>
      parseScratchAccess(loopbackArgs, { keep: false, listOnly: false, restoreOnly: false }),
    ).toThrow();
    for (const port of [1024, 65535])
      expect(
        parseScratchAccess(
          [`--scratch-loopback-port=${port}`, '--scratch-database=test_fork_001'],
          { keep: true, listOnly: false, restoreOnly: false },
        ),
      ).toMatchObject({ port });
    const directory = mkdtempSync(join(TMP, 'scratch-capture-')),
      transport = offlineTransport(directory, 'success');
    expect(
      offlineCli(directory, transport, ['--operation=capture-parity', ...loopbackArgs]).status,
    ).toBe(1);
    expect(transportCommands(directory)).toEqual([]);
  });
  it('retains the exact new loopback identity, observed volume and attempt and uses IDs for every exec', () => {
    const directory = mkdtempSync(join(TMP, 'scratch-loopback-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'receipt.json');
    const result = offlineCli(directory, transport, [
      ...restoreArgs(transport, out),
      ...loopbackArgs,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const receipt = parseRestoreReceipt(readJsonArtifact(out).value);
    expect(receipt).toMatchObject({
      kind: 'verified',
      scratch: {
        retained: true,
        ownership: {
          container_id: 'c'.repeat(64),
          volumes: [{ name: 'offline-anonymous-volume', destination: '/var/lib/postgresql/data' }],
        },
        reopen: {
          container_id: 'c'.repeat(64),
          host: '127.0.0.1',
          port: 15555,
          identity: {
            database: 'test_fork_20261009',
            database_oid: '16385',
            cluster: '8007199254741001',
            in_recovery: false,
          },
        },
      },
    });
    const commands = transportCommands(directory);
    const run = commands.find((c) => c.args[0] === 'run');
    expect(run?.args).toEqual(
      expect.arrayContaining([
        '--pull=never',
        '--network=bridge',
        '127.0.0.1:15555:5432',
        'POSTGRES_DB=test_fork_20261009',
      ]),
    );
    for (let i = 0; i < commands.length; i++)
      if (commands[i].args[0] === 'exec') {
        expect(commands[i].args).toContain('c'.repeat(64));
        expect(commands[i - 1].args).toEqual(['inspect', 'c'.repeat(64)]);
      }
    expect(commands.some((c) => c.args[0] === 'rm')).toBe(false);
  });
  it.each([
    'ambiguous-create',
    'ambiguous-signal',
    'unexpected-volume',
    'storage-race',
    'cleanup-owner',
    'collision',
    'unknown-id',
    'wrong-owner',
    'wrong-image',
    'wrong-name',
    'wrong-id',
    'wrong-db-env',
    'mapping',
    'mapping-race',
    'same-cluster',
    'identity-race',
    'restart-race',
    'recovery',
    'inventory',
  ])('fails closed for %s without unsafe cleanup or reopen', (mode) => {
    const directory = mkdtempSync(join(TMP, 'scratch-race-')),
      transport = offlineTransport(directory, mode),
      out = join(directory, 'receipt.json');
    const result = offlineCli(directory, transport, [
      ...restoreArgs(transport, out),
      ...loopbackArgs,
    ]);
    expect(result.status, result.stderr).toBe(1);
    const receipt = parseRestoreReceipt(readJsonArtifact(out).value);
    if (receipt.kind !== 'failed') throw new Error('expected failed receipt');
    expect(receipt.scratch.reopen).toBeUndefined();
    expect(receipt.scratch.retained).toBe(
      ['same-cluster', 'identity-race', 'restart-race', 'recovery', 'inventory'].includes(mode),
    );
    expect(transportCommands(directory).some((c) => c.args[0] === 'rm')).toBe(false);
  });
  it('default stays network-none and removes only verified IDs and anonymous volumes', () => {
    const directory = mkdtempSync(join(TMP, 'scratch-default-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'receipt.json');
    expect(offlineCli(directory, transport, restoreArgs(transport, out)).status).toBe(0);
    const commands = transportCommands(directory);
    expect(commands.find((c) => c.args[0] === 'run')?.args).toContain('--network=none');
    expect(commands.at(-1)?.args).toEqual(['rm', '-f', '-v', 'c'.repeat(64)]);
    expect(commands.at(-2)?.args).toEqual(['inspect', 'c'.repeat(64)]);
  });
  it('does not remove an ambiguous created container even without keep', () => {
    const directory = mkdtempSync(join(TMP, 'scratch-unknown-')),
      transport = offlineTransport(directory, 'ambiguous-create'),
      out = join(directory, 'receipt.json');
    expect(offlineCli(directory, transport, restoreArgs(transport, out)).status).toBe(1);
    expect(transportCommands(directory).some((c) => c.args[0] === 'rm')).toBe(false);
  });
  it('refuses cleanup after ownership changed during inspection', () => {
    const directory = mkdtempSync(join(TMP, 'cleanup-owner-')),
      transport = offlineTransport(directory, 'cleanup-owner'),
      out = join(directory, 'receipt.json');
    expect(offlineCli(directory, transport, restoreArgs(transport, out)).status).toBe(1);
    expect(parseRestoreReceipt(readJsonArtifact(out).value)).toMatchObject({
      kind: 'failed',
      scratch: { retained: false },
      errors: [expect.objectContaining({ phase: 'cleanup' })],
    });
    expect(transportCommands(directory).some((c) => c.args[0] === 'rm')).toBe(false);
  });
  it('rejects forged failed, unretained, wrong-container and recovery reopen receipts', () => {
    const directory = mkdtempSync(join(TMP, 'scratch-forged-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'receipt.json');
    expect(
      offlineCli(directory, transport, [...restoreArgs(transport, out), ...loopbackArgs]).status,
    ).toBe(0);
    const receipt = z
      .object({ scratch: z.object({ reopen: z.unknown() }).passthrough() })
      .passthrough()
      .parse(readJsonArtifact(out).value);
    for (const delta of [
      { kind: 'failed', level: 'failed', verified: false },
      { scratch: { ...receipt.scratch, retained: false } },
      { scratch: { ...receipt.scratch, ownership: undefined } },
      {
        scratch: {
          ...receipt.scratch,
          reopen: {
            ...z
              .object({ identity: z.object({}).passthrough() })
              .passthrough()
              .parse(receipt.scratch.reopen),
            container_id: 'd'.repeat(64),
          },
        },
      },
    ])
      expect(() => parseRestoreReceipt({ ...receipt, ...delta })).toThrow();
  });
});

describe('host provenance and explicit lazy driver', () => {
  it('the final-backup shell cannot turn inherited database URLs into an explicit capture target', () => {
    const directory = mkdtempSync(join(TMP, 'host-shell-explicit-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'capture');
    rmSync(join(transport.bin, 'node'));
    const result = spawnSync(
      '/bin/bash',
      [
        'scripts/cutover-final-backup.sh',
        `--out=${out}`,
        `--quiescence-evidence=${transport.source.quiescence.artifact.file}`,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: `${transport.bin}:${process.env.PATH}`,
          HOME: process.env.HOME,
          NODE_OPTIONS: `--import=${transport.preload}`,
          DATABASE_URL: 'postgres://offline:offline@offline/loom',
          LOOM_CUTOVER_TARGET: 'postgres://offline:offline@offline/loom',
        },
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(transportCommands(directory)).toEqual([]);
    expect(requireDirectory(out).some((f) => f.startsWith('capture-failed-'))).toBe(true);
  });
  it('keeps artifact bindings pure and requires observed host digests for full assembly', () => {
    const directory = mkdtempSync(join(TMP, 'host-pure-bindings-')),
      transport = offlineTransport(directory, 'success'),
      evidence = hostEvidence(directory, transport.source);
    useHostEvidence(transport, evidence);
    const executionArtifacts = validateExecutionArtifacts(evidence),
      source = transport.source;
    if (!executionArtifacts || evidence.version !== 2) throw new Error('expected host artifacts');
    const bindings = {
      source,
      dump: source.dump,
      sourceArtifact: artifactIdentity(transport.sourcePath),
      receipt: receiptFixture(source, transport.sourcePath),
      quiescence: evidence,
      quiescenceArtifact: source.quiescence.artifact,
    };
    expect(() => validateArtifactBindings(bindings)).toThrow(/observations required/);
    rmSync(evidence.execution.worker.artifact.file);
    expect(() => validateArtifactBindings({ ...bindings, executionArtifacts })).not.toThrow();
    expect(() =>
      validateArtifactBindings({
        ...bindings,
        executionArtifacts: {
          ...executionArtifacts,
          worker: { ...executionArtifacts.worker, sha256: 'f'.repeat(64) },
        },
      }),
    ).toThrow(/binding mismatch/);
    expect(() =>
      validateArtifactBindings({
        ...bindings,
        executionArtifacts: {
          ...executionArtifacts,
          runtime: { ...executionArtifacts.runtime, version: 'v1.0.0' },
        },
      }),
    ).toThrow(/runtime version mismatch/);
    expect(() =>
      validateArtifactBindings({ ...bindings, quiescence: undefined, executionArtifacts }),
    ).toThrow(/quiescence artifact observations required/);
  });
  it('validates actual host artifact bytes and passes the same full restore path', () => {
    const directory = mkdtempSync(join(TMP, 'host-provenance-')),
      transport = offlineTransport(directory, 'success'),
      evidence = hostEvidence(directory, transport.source),
      out = join(directory, 'receipt.json');
    useHostEvidence(transport, evidence);
    expect(() => validateExecutionArtifacts(evidence)).not.toThrow();
    expect(
      offlineCli(directory, transport, [...restoreArgs(transport, out), ...loopbackArgs]).status,
    ).toBe(0);
    expect(parseRestoreReceipt(readJsonArtifact(out).value)).toMatchObject({
      kind: 'verified',
      source: { quiescence: { evidence: { version: 2, execution: { app: { kind: 'absent' } } } } },
    });
  });
  it.each(['worker-bytes', 'runtime-bytes', 'runtime-version'])(
    'rejects actual %s mismatch before Docker',
    (mode) => {
      const directory = mkdtempSync(join(TMP, 'host-mismatch-')),
        transport = offlineTransport(directory, 'success'),
        evidence = hostEvidence(directory, transport.source),
        out = join(directory, 'receipt.json');
      if (evidence.version !== 2) throw new Error('expected host evidence');
      if (mode === 'worker-bytes')
        writeFileSync(evidence.execution.worker.artifact.file, 'changed worker');
      if (mode === 'runtime-bytes')
        evidence.execution.runtime.artifact = evidence.execution.worker.artifact;
      if (mode === 'runtime-version') evidence.execution.runtime.version = 'v1.0.0';
      useHostEvidence(transport, evidence);
      expect(offlineCli(directory, transport, restoreArgs(transport, out)).status).toBe(1);
      expect(transportCommands(directory)).toEqual([]);
    },
  );
  it.each([
    'driver-connect',
    'driver-query',
    'driver-json',
    'driver-close',
    'driver-close-timeout',
    'driver-interrupt',
    'driver-timeout',
  ])(
    'bounds and closes %s with sanitized failure',
    (mode) => {
      const directory = mkdtempSync(join(TMP, 'host-driver-')),
        transport = offlineTransport(directory, mode),
        out = join(directory, 'capture');
      const result = offlineCli(directory, transport, [
        '--operation=capture-parity',
        `--out=${out}`,
        '--target=postgres://offline:offline@offline/loom',
        `--quiescence-evidence=${transport.source.quiescence.artifact.file}`,
        '--container=offline-source',
      ]);
      expect(result.status, result.stderr).toBe(1);
      const commands = transportCommands(directory);
      expect(commands.filter((c) => c.tool === 'postgres' && c.args[0] === 'end')).toEqual([
        { tool: 'postgres', args: ['end', '1'] },
      ]);
      const diagnostics =
        result.stderr +
        requireDirectory(out)
          .filter((f) => f.endsWith('capture-failed.json'))
          .map((f) => readFileSync(join(out, f), 'utf8'))
          .join();
      expect(diagnostics).not.toMatch(/SECRET|postgres:\/\/|offline:offline/);
      expect(commands.some((c) => c.tool === 'psql')).toBe(false);
    },
    25_000,
  );
  it.each([
    'postgres://offline/loom',
    'postgres://offline:offline@offline/',
    'https://offline/loom',
    'postgres://offline:offline@offline/loom?host=other',
    'postgres://offline:offline@offline/loom?sslmode=disable&sslmode=require',
  ])('rejects non-explicit or ambiguous target %s before driver import', (target) => {
    const directory = mkdtempSync(join(TMP, 'host-explicit-')),
      transport = offlineTransport(directory, 'success'),
      out = join(directory, 'capture');
    const result = offlineCli(directory, transport, [
      '--operation=capture-parity',
      `--out=${out}`,
      `--target=${target}`,
      `--quiescence-evidence=${transport.source.quiescence.artifact.file}`,
      '--container=offline-source',
    ]);
    expect(result.status).toBe(1);
    expect(transportCommands(directory).some((c) => c.tool === 'postgres')).toBe(false);
  });
});
