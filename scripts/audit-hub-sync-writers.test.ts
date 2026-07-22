import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { type AllowlistEntry, auditHubSyncWriters } from './audit-hub-sync-writers';

const emptyAllowlist: AllowlistEntry[] = [];
const fixtures: string[] = [];
const withDb = (source: string) =>
  /from\s*['"]@\/db\/client['"]/.test(source)
    ? source
    : `import { db } from '@/db/client';\n${source}`;

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hub-sync-audit-'));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('auditHubSyncWriters', () => {
  it.each([
    [
      'topology writer',
      "await db.update(knowledge).set({ name: 'x' });",
      'UNINVENTORIED_TOPOLOGY_WRITER',
    ],
    [
      'cursor writer',
      "await db.update(hub_sync_reconciliation).set({ status: 'acknowledged' });",
      'RECONCILIATION_OWNER_BYPASS',
    ],
    [
      'internal marker',
      "await db.execute(sql`set local app.hub_sync_internal_apply = '1'`);",
      'INTERNAL_APPLY_MARKER_BYPASS',
    ],
    [
      'direct apply actor',
      "persistNoteRefineApply({ db, artifactId, patch, actorRef: 'hub_auto_sync' });",
      'DIRECT_HUB_ACTOR_APPLY',
    ],
  ] as const)('YUK-384 RED 25: catches %s bypass', async (_name, source, rule) => {
    const root = fixtureRepo({ 'src/bypass.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(expect.objectContaining({ rule, file: 'src/bypass.ts' }));
  });

  it('YUK-384 RED 25: an allowlisted topology writer is NOT flagged', async () => {
    const root = fixtureRepo({ 'src/writer.ts': 'await db.insert(knowledge_edge).values({});' });
    const findings = await auditHubSyncWriters({
      root,
      allowlist: [{ path: 'src/writer.ts', tables: ['knowledge_edge'], reason: 'test' }],
    });
    expect(findings).toEqual([]);
  });

  it.each([
    ['insert', 'knowledge', 'db\n  .insert(\n    knowledge,\n  )\n  .values({});'],
    ['update', 'knowledge_edge', 'db\n  .update(\n    knowledge_edge,\n  )\n  .set({});'],
    ['delete', 'knowledge', 'db\n  .delete(\n    knowledge,\n  )\n  .where(eq(knowledge.id, id));'],
  ])('YUK-746 RED: catches multiline Drizzle %s calls', async (_operation, _table, source) => {
    const root = fixtureRepo({ 'src/multiline.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({
        rule: 'UNINVENTORIED_TOPOLOGY_WRITER',
        file: 'src/multiline.ts',
      }),
    );
  });

  it('YUK-746 RED: ignores write-shaped text in multiline comments and strings', async () => {
    const root = fixtureRepo({
      'src/non-writers.ts': `
        /*
         * db.insert(knowledge).values({});
         * db.update(hub_sync_reconciliation).set({});
         */
        const examples = [
          "db.delete(knowledge_edge)",
          "app.hub_sync_internal_apply",
          "actorRef: 'hub_auto_sync'",
        ];
      `,
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toEqual([]);
  });

  it.each([
    ['optional call', 'db.insert?.(knowledge).values({})'],
    ['type argument', 'db.insert<typeof knowledge>(knowledge).values({})'],
    ['parenthesized table', 'db.insert((knowledge)).values({})'],
    [
      'transaction receiver',
      "import type { Tx } from '@/db/client'; function write(tx: Tx) { tx.update(knowledge).set({}); }",
    ],
    ['nested template expression', 'const value = `ignored ${`also ${db.delete(knowledge)}`}`'],
  ])('YUK-746 review: catches %s Drizzle syntax', async (_name, source) => {
    const root = fixtureRepo({ 'src/writer.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'inline typed destructured parameter',
      "import type { Db } from '@/db/client'; function write({ db }: { db: Db }) { db.insert(knowledge).values({}); }",
    ],
    [
      'aliased typed destructured parameter',
      "import type { Db } from '@/db/client'; type Deps = { db: Db }; function write({ db: writerDb }: Deps) { writerDb.update(knowledge_edge).set({}); }",
    ],
    [
      'nested renamed default typed destructured parameter',
      "import type { Tx } from '@/db/client'; type Deps = { nested: { db: Tx } }; function write({ nested: { db: writerTx = fallback } }: Deps) { writerTx.delete(knowledge).where(ok); }",
    ],
    [
      'typed dbOrTx parameter',
      "import type { Tx } from '@/db/client';\nfunction write(dbOrTx: Tx) { return dbOrTx.insert(knowledge).values({}); }",
    ],
    [
      'typed repository union',
      "import type { Db, Tx } from '@/db/client';\nfunction write(repositoryDb: Db | Tx) { return repositoryDb.update(knowledge_edge).set({}); }",
    ],
    [
      'import alias',
      "import { db as repositoryDb } from '@/db/client';\nrepositoryDb.delete(knowledge).where(ok);",
    ],
    [
      'alias fixed point',
      "import { db } from '@/db/client';\nconst repositoryDb = db; const writerDb = repositoryDb; writerDb.insert(knowledge).values({});",
    ],
    [
      'transaction callback',
      "import { db } from '@/db/client';\ndb.transaction(async (writerTx) => writerTx.update(knowledge).set({}));",
    ],
  ])(
    'YUK-746 review follow-up: catches Drizzle calls through %s provenance',
    async (_name, source) => {
      const root = fixtureRepo({ 'src/aliased-writer.ts': source });
      const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
      expect(findings).toContainEqual(
        expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
      );
    },
  );

  it.each([
    [
      'exact relative import alias',
      "import { db as repositoryDb } from '../src/db/client'; repositoryDb.insert(knowledge).values({});",
    ],
    [
      'typed union',
      "import type { Db, Tx } from '@/db/client'; function write(client: Db | Tx | undefined) { client?.update(knowledge).set({}); }",
    ],
    [
      'typeof trusted binding',
      "import { db } from '@/db/client'; function write(client: typeof db) { client.delete(knowledge).where(ok); }",
    ],
    [
      'chained type aliases',
      "import { db } from '@/db/client'; type RepositoryDb = typeof db; type MaybeDb = RepositoryDb | undefined; function write(client: MaybeDb) { client?.insert(knowledge).values({}); }",
    ],
    [
      'inline transaction callback',
      "import { db } from '@/db/client'; db.transaction(async (tx) => tx.update(knowledge_edge).set({}));",
    ],
  ])('YUK-746 AST: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/ast-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'value namespace db member',
      "import * as repoDb from '@/db/client'; repoDb.db.insert(knowledge).values({});",
    ],
    [
      'inline repo Db import type',
      "function write(client: import('@/db/client').Db) { client.update(knowledge).set({}); }",
    ],
    [
      'inline repo Tx import type',
      "function write(client: import('../src/db/client').Tx) { client.delete(knowledge_edge).where(ok); }",
    ],
    [
      'object property arrow capture',
      "import { db } from '@/db/client'; const client = db; const writer = { run: () => client.insert(knowledge).values({}) };",
    ],
    [
      'object property function capture',
      "import { db } from '@/db/client'; const client = db; const writer = { run: function () { client.update(knowledge_edge).set({}); } };",
    ],
    [
      'Promise.all tuple namespace destructuring',
      "const [{ db }] = await Promise.all([import('@/db/client')]); db.delete(knowledge).where(ok);",
    ],
    [
      'flattened array spread preserves trusted position',
      "const [, { db }] = [...[foreignClient, await import('@/db/client')]]; db.insert(knowledge).values({});",
    ],
    [
      'Promise.all evaluates later arguments',
      "import { db } from '@/db/client'; Promise.all([], db.insert(knowledge).values({}));",
    ],
    [
      'optional value namespace db member',
      "import * as repoDb from '@/db/client'; repoDb?.db.update(knowledge).set({});",
    ],
    [
      'computed Promise all',
      "const [{ db }] = await Promise['all']([import('@/db/client')]); db.delete(knowledge).where(ok);",
    ],
    [
      'optional Promise member',
      "const [{ db }] = await Promise?.all([import('@/db/client')]); db.insert(knowledge_edge).values({});",
    ],
    [
      'optional Promise call',
      "const [{ db }] = await Promise.all?.([import('@/db/client')]); db.update(knowledge).set({});",
    ],
    [
      'unknown trailing spread preserves trusted prefix',
      "const [{ db }] = [await import('@/db/client'), ...unknownValues]; db.update(knowledge).set({});",
    ],
    [
      'Promise.all unknown trailing spread preserves trusted prefix',
      "const [{ db }] = await Promise.all([import('@/db/client'), ...unknownValues]); db.delete(knowledge).where(ok);",
    ],
    [
      'known Promise.all call-argument spread preserves nested tuple',
      "const [, { db }] = await Promise.all(...[[foreign, import('@/db/client')]]); db.insert(knowledge_edge).values({});",
    ],
    [
      'unknown Promise.all call-argument spread still scans side effects',
      "import { db } from '@/db/client'; Promise.all(...unknownArgs, db.update(knowledge).set({}));",
    ],
    [
      'direct function typed parameter',
      "((client: import('@/db/client').Db) => client.insert(knowledge).values({}))(cache);",
    ],
    [
      'direct function typed destructured parameter',
      "(({ db }: { db: import('@/db/client').Tx }) => db.update(knowledge).set({}))({ db: cache });",
    ],
    [
      'direct function default typed destructured parameter',
      "(({ db }: { db: import('@/db/client').Db } = fallback) => db.delete(knowledge_edge).where(ok))();",
    ],
  ])('YUK-746 exact-head blockers: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/exact-head-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'arbitrary value namespace property',
      "import * as repoDb from '@/db/client'; repoDb.cache.insert(knowledge).values({});",
    ],
    [
      'foreign inline import type',
      "function write(client: import('cache/db/client').Db) { client.insert(knowledge).values({}); }",
    ],
    [
      'qualified inline repo import type',
      "function write(client: import('@/db/client').nested.Db) { client.insert(knowledge).values({}); }",
    ],
    [
      'foreign Promise.all tuple element',
      "const [{ db }] = await Promise.all([import('cache/db/client'), import('@/db/client')]); db.insert(knowledge).values({});",
    ],
    [
      'unknown array spread invalidates positional provenance',
      "const [{ db }] = [...unknownValues, await import('@/db/client')]; db.insert(knowledge).values({});",
    ],
    [
      'known spread does not leak trust across positions',
      "const [{ db }] = [...[await import('cache/db/client'), await import('@/db/client')]]; db.update(knowledge).set({});",
    ],
    [
      'shadowed computed Promise all',
      "function run(Promise) { const [{ db }] = Promise['all']([import('@/db/client')]); db.delete(knowledge).where(ok); }",
    ],
    [
      'known Promise.all call spread does not leak trust across elements',
      "const [{ db }] = await Promise.all(...[[import('cache/db/client'), import('@/db/client')]]); db.insert(knowledge).values({});",
    ],
    [
      'unknown Promise.all call spread does not guess tuple provenance',
      "const [{ db }] = await Promise.all(...unknownArgs, [import('@/db/client')]); db.update(knowledge).set({});",
    ],
    [
      'tuple trust does not leak across elements',
      "const [cache, repo] = [foreignClient, await import('@/db/client')]; cache.db.update(knowledge).set({});",
    ],
  ])('YUK-746 exact-head blockers: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/exact-head-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    [
      'named transaction callback',
      "import { db } from '@/db/client'; function write(tx) { tx.insert(knowledge).values({}); } db.transaction(write);",
    ],
    [
      'aliased transaction callback',
      "import { db } from '@/db/client'; const write = (tx) => tx.update(knowledge).set({}); const alias = write; db.transaction(alias);",
    ],
    [
      'Drizzle with receiver',
      "import { db } from '@/db/client'; db.with(cte).delete(knowledge_edge).where(ok);",
    ],
    [
      'object property invoked after captured assignment',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; client = db; writer.run();",
    ],
    [
      'stored literal sql.raw',
      "import { db } from '@/db/client'; const query = sql.raw('update knowledge set name = 1'); db.execute(query);",
    ],
    [
      'stored immutable string sql.raw',
      "import { db } from '@/db/client'; const text = 'delete from knowledge_edge'; const query = sql.raw(text); db.execute(query);",
    ],
    [
      'exported closure widened to final capture',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.update(knowledge).set({}); client = db; export default writer;",
    ],
    [
      'registered closure widened to final capture',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.delete(knowledge_edge).where(ok); register(writer); client = db;",
    ],
  ])('YUK-746 OCR fail-safe: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/ocr-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'foreign transaction receiver does not trust callback',
      'function write(tx) { tx.insert(knowledge).values({}); } cache.transaction(write);',
    ],
    ['foreign with receiver', 'cache.with(cte).update(knowledge).set({});'],
    [
      'object property call before assignment',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; writer.run(); client = db;",
    ],
    [
      'object property never called',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; client = db;",
    ],
    [
      'foreign object property',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; client = db; foreign.run();",
    ],
    [
      'foreign execute stored raw',
      "const text = 'u' + 'pdate knowledge set name = 1'; const query = sql.raw(text); cache.execute(query);",
    ],
    [
      'unknown stored raw',
      "import { db } from '@/db/client'; const query = sql.raw(dynamicText); db.execute(query);",
    ],
    [
      'mutated stored raw',
      "import { db } from '@/db/client'; const text = 'u' + 'pdate knowledge set name = 1'; let query = sql.raw(text); query = safeQuery; db.execute(query);",
    ],
    [
      'nonescaped closure stays call-time precise',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.update(knowledge).set({}); writer(); client = db;",
    ],
  ])('YUK-746 OCR fail-safe: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/ocr-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    [
      'export variable declaration closure',
      "import { db } from '@/db/client'; let client = cache; export const writer = () => client.insert(knowledge).values({}); client = db;",
    ],
    [
      'export aliased specifier closure',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.update(knowledge).set({}); client = db; export { writer as run };",
    ],
    [
      'exported object closure',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.delete(knowledge_edge).where(ok) }; client = db; export { writer };",
    ],
    [
      'registered object property closure',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; register(writer.run); client = db;",
    ],
  ])('YUK-746 exact-head escape discovery: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/escape-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'overwritten named callback',
      "import { db } from '@/db/client'; function writer(tx) { tx.insert(knowledge).values({}); } writer = safe; db.transaction(writer);",
    ],
    [
      'overwritten callback alias',
      "import { db } from '@/db/client'; const writer = (tx) => tx.update(knowledge).set({}); let alias = writer; alias = safe; db.transaction(alias);",
    ],
    [
      'overwritten whole object',
      "import { db } from '@/db/client'; let client = cache; let writer = { run: () => client.insert(knowledge).values({}) }; writer = safeObject; client = db; writer.run();",
    ],
    [
      'overwritten object property',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; writer.run = safe; client = db; writer.run();",
    ],
    ['raw construction alone', "sql.raw('update knowledge set name = 1');"],
    ['foreign raw execution', "cache.execute(sql.raw('delete from knowledge'));"],
    ['foreign tagged execution', 'cache.execute(sql`insert into knowledge_edge (id) values (1)`);'],
  ])('YUK-746 exact-head invalidation and SQL gating: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/invalidation-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it('YUK-746 exact-head SQL gating retains trusted tagged execution', async () => {
    const root = fixtureRepo({
      'src/tagged-positive.ts': withDb('db.execute(sql`update knowledge set name = ${value}`);'),
    });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'dependency object shorthand property',
      "import { db } from '@/db/client'; const deps = { db }; deps.db.insert(knowledge).values({});",
    ],
    [
      'dependency object aliased property destructuring',
      "import { db } from '@/db/client'; const deps = { client: db }; const { client } = deps; client.update(knowledge_edge).set({});",
    ],
    [
      'dependency object alias',
      "import { db } from '@/db/client'; const deps = { client: db }; const alias = deps; alias.client.delete(knowledge).where(ok);",
    ],
    [
      'dependency property assigned before use',
      "import { db } from '@/db/client'; const deps = { client: cache }; deps.client = db; deps.client.insert(knowledge).values({});",
    ],
    [
      'CommonJS module exports property',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.insert(knowledge).values({}); client = db; module.exports.writer = writer;",
    ],
  ])('YUK-746 fresh Important blockers: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/fresh-important-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'foreign dependency object property',
      'const deps = { db: cache }; deps.db.insert(knowledge).values({});',
    ],
    [
      'CommonJS module exports property follows final safe state',
      "import { db } from '@/db/client'; let client = db; const writer = () => client.insert(knowledge).values({}); module.exports.writer = writer; client = cache;",
    ],
    [
      'foreign CommonJS-shaped property assignment',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.update(knowledge).set({}); client = db; loader.module.exports.writer = writer;",
    ],
  ])('YUK-746 fresh Important blockers: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/fresh-important-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    [
      'inline object callback registrar',
      "import { db } from '@/db/client'; let client = cache; register({ run: () => client.insert(knowledge).values({}) }); client = db;",
    ],
    [
      'inline array callback registrar',
      "import { db } from '@/db/client'; let client = cache; register([() => client.update(knowledge).set({})]); client = db;",
    ],
    [
      'returned closure from exported factory',
      "import { db } from '@/db/client'; let client = cache; export function factory() { return () => client.delete(knowledge_edge).where(ok); } client = db;",
    ],
    [
      'TypeScript export assignment',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.insert(knowledge).values({}); client = db; export = writer;",
    ],
    [
      'CommonJS module exports',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.update(knowledge).set({}); client = db; module.exports = writer;",
    ],
    [
      'CommonJS named exports',
      "import { db } from '@/db/client'; let client = cache; const writer = () => client.delete(knowledge_edge).where(ok); client = db; exports.writer = writer;",
    ],
  ])('YUK-746 remaining escapes: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/remaining-escape-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'static computed property reassignment',
      "import { db } from '@/db/client'; let client = cache; const writer = { run: () => client.insert(knowledge).values({}) }; writer['run'] = safe; client = db; writer.run();",
    ],
    [
      'assignment destructuring invalidates callback',
      "import { db } from '@/db/client'; let writer = (tx) => tx.update(knowledge).set({}); ({ writer } = safe); db.transaction(writer);",
    ],
    [
      'array assignment destructuring invalidates callback',
      "import { db } from '@/db/client'; let writer = (tx) => tx.delete(knowledge_edge).where(ok); [writer] = safe; db.transaction(writer);",
    ],
    [
      'update expression invalidates callback',
      "import { db } from '@/db/client'; let writer = (tx) => tx.insert(knowledge).values({}); writer++; db.transaction(writer);",
    ],
    [
      'nonexported factory returned closure stays precise',
      "import { db } from '@/db/client'; let client = cache; function factory() { return () => client.update(knowledge).set({}); } factory(); client = db;",
    ],
  ])('YUK-746 remaining invalidation: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/remaining-invalidation-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    [
      'exported interface parameter',
      "import type { Db } from '@/db/client'; export interface Deps { db: Db } function write({ db }: Deps) { db.insert(knowledge).values({}); }",
    ],
    [
      'exported type alias parameter',
      "import type { Tx } from '@/db/client'; export type Deps = { db: Tx }; function write({ db }: Deps) { db.update(knowledge_edge).set({}); }",
    ],
    [
      'assigned object property closure',
      "import { db } from '@/db/client'; let client = cache; const handlers = {}; handlers.sync = () => client.delete(knowledge).where(ok); client = db; handlers.sync();",
    ],
    [
      'assigned computed object property closure',
      "import { db } from '@/db/client'; let client = cache; const handlers = {}; handlers['sync'] = () => client.insert(knowledge).values({}); client = db; handlers.sync();",
    ],
    [
      'object method shorthand',
      "import { db } from '@/db/client'; let client = cache; const handlers = { sync() { client.update(knowledge).set({}); } }; client = db; handlers.sync();",
    ],
    [
      'computed object method shorthand',
      "import { db } from '@/db/client'; let client = cache; const handlers = { ['sync']() { client.delete(knowledge_edge).where(ok); } }; client = db; handlers.sync();",
    ],
    [
      'raw write survives later string reassignment',
      "import { db } from '@/db/client'; const text = 'update knowledge set name = 1'; db.execute(sql.raw(text)); text = 'select 1';",
    ],
    [
      'raw marker survives later string reassignment',
      "import { db } from '@/db/client'; const text = \"set local app.hub_sync_internal_apply = '1'\"; db.execute(sql.raw(text)); text = 'select 1';",
    ],
  ])('YUK-746 exact-head remaining: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/exact-head-remaining-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).not.toEqual([]);
  });

  it.each([
    [
      'foreign assigned object property closure',
      'let client = cache; const handlers = {}; handlers.sync = () => client.insert(knowledge).values({}); client = other; handlers.sync();',
    ],
    [
      'overwritten assigned property closure',
      "import { db } from '@/db/client'; let client = cache; const handlers = {}; handlers.sync = () => client.insert(knowledge).values({}); handlers.sync = safe; client = db; handlers.sync();",
    ],
    [
      'object method called before assignment',
      "import { db } from '@/db/client'; let client = cache; const handlers = { sync() { client.update(knowledge).set({}); } }; handlers.sync(); client = db;",
    ],
  ])('YUK-746 exact-head remaining: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/exact-head-remaining-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['untyped client', 'function write(client) { client.insert(knowledge).values({}); }'],
    [
      'fake line comment import',
      "// import { db } from '@/db/client';\ndb.insert(knowledge).values({});",
    ],
    [
      'fake block comment import',
      "/* import { db } from '@/db/client'; */ db.insert(knowledge).values({});",
    ],
    [
      'fake string import',
      'const text = "import { db } from \'@/db/client\'"; db.insert(knowledge).values({});',
    ],
    [
      'fake template import',
      "const text = `import { db } from '@/db/client'`; db.insert(knowledge).values({});",
    ],
    [
      'fake interpolation import',
      'const text = `${"import { db } from \'@/db/client\'"}`; db.insert(knowledge).values({});',
    ],
    [
      'suffix package path',
      "import { db } from 'other/db/client'; db.insert(knowledge).values({});",
    ],
    [
      'foreign typed destructured property',
      "import type { Db } from 'cache/db/client'; function write({ db }: { db: Db }) { db.insert(knowledge).values({}); }",
    ],
    [
      'untrusted typed destructured property',
      'type Deps = { db: Cache }; function write({ db }: Deps) { db.insert(knowledge).values({}); }',
    ],
    [
      'typed destructured rest stays untrusted',
      "import type { Db } from '@/db/client'; type Deps = { db: Db; cache: Cache }; function write({ ...rest }: Deps) { rest.insert(knowledge).values({}); }",
    ],
    [
      'typed receiver does not leak functions',
      "import type { Db } from '@/db/client'; function first(client: Db) {} function second(client) { client.insert(knowledge).values({}); }",
    ],
    [
      'untyped inner parameter shadows',
      "import { db } from '@/db/client'; function inner(db) { db.insert(knowledge).values({}); }",
    ],
    [
      'untyped inner local shadows',
      "import { db } from '@/db/client'; { const db = cache; db.insert(knowledge).values({}); }",
    ],
    [
      'destructuring shadows',
      "import { db } from '@/db/client'; function inner({ db }) { db.insert(knowledge).values({}); }",
    ],
    [
      'catch binding shadows',
      "import { db } from '@/db/client'; try {} catch (db) { db.insert(knowledge).values({}); }",
    ],
    [
      'transaction callback does not leak',
      "import { db } from '@/db/client'; db.transaction(async (tx) => {}); tx.insert(knowledge).values({});",
    ],
    [
      'named transaction handler',
      "import { db } from '@/db/client'; function handler(tx) { tx.insert(knowledge).values({}); } cache.transaction(handler);",
    ],
  ])('YUK-746 AST: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/ast-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    [
      'for-let scope cleanup',
      "import { db } from '@/db/client'; for (let db = cache; ok; next()) {} db.insert(knowledge).values({});",
    ],
    [
      'for-of const scope cleanup',
      "import { db } from '@/db/client'; for (const db of caches) {} db.insert(knowledge).values({});",
    ],
    [
      'trusted alias assignment',
      "import { db } from '@/db/client'; let client; client = db; client.insert(knowledge).values({});",
    ],
    [
      'typed default parameter',
      "import type { Db } from '@/db/client'; function write(client: Db = fallback) { client.insert(knowledge).values({}); }",
    ],
    [
      'typed rest parameter',
      "import type { Db } from '@/db/client'; function write(...client: Db) { client.insert(knowledge).values({}); }",
    ],
    [
      'wrapped transaction callback',
      "import { db } from '@/db/client'; db.transaction(((tx) => tx.insert(knowledge).values({})) as Callback);",
    ],
    [
      'namespace type parameter',
      "import type * as Repository from '@/db/client'; function write(tx: Repository.Tx) { tx.insert(knowledge).values({}); }",
    ],
    ['hoisted import trust', "db.insert(knowledge).values({}); import { db } from '@/db/client';"],
    [
      'trusted intersection',
      "import type { Tx } from '@/db/client'; function write(tx: Tx & Extra) { tx.insert(knowledge).values({}); }",
    ],
  ])('YUK-746 review fixes: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/review-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'object method parameter shadow',
      "import { db } from '@/db/client'; const value = { write(db) { db.insert(knowledge).values({}); } };",
    ],
    [
      'class method parameter shadow',
      "import { db } from '@/db/client'; class Writer { write(db) { db.insert(knowledge).values({}); } }",
    ],
    [
      'for-let body shadow',
      "import { db } from '@/db/client'; for (let db = cache; ok; next()) { db.insert(knowledge).values({}); }",
    ],
    [
      'for-var function shadow',
      "import { db } from '@/db/client'; function write() { db.insert(knowledge).values({}); for (var db = cache; ok; next()) {} }",
    ],
    [
      'reassignment away',
      "import { db } from '@/db/client'; let client = db; client = cache; client.insert(knowledge).values({});",
    ],
    [
      'update invalidates',
      "import { db } from '@/db/client'; let client = db; client++; client.insert(knowledge).values({});",
    ],
    [
      'destructuring assignment invalidates',
      "import { db } from '@/db/client'; let client = db; ({ client } = cache); client.insert(knowledge).values({});",
    ],
    [
      'foreign namespace type',
      "import type * as Repository from 'other/db/client'; function write(tx: Repository.Tx) { tx.insert(knowledge).values({}); }",
    ],
    [
      'generic substitution respects use-site type parameter shadowing',
      "import type { Db } from '@/db/client'; type D<T> = { db: T }; function f<Db>({ db }: D<Db>) { db.insert(knowledge).values({}); }",
    ],
    [
      'conflicting property intersection',
      "import type { Db } from '@/db/client'; function f({ db }: { db: Db } & { db: Cache }) { db.insert(knowledge).values({}); }",
    ],
    [
      'mixed untrusted union',
      "import type { Tx } from '@/db/client'; function write(tx: Tx | S3Client) { tx.insert(knowledge).values({}); }",
    ],
  ])('YUK-746 review fixes: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/review-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    [
      'assignment computed lhs',
      "import { db } from '@/db/client'; target[db.insert(knowledge).values({})] = value;",
    ],
    [
      'update computed argument',
      "import { db } from '@/db/client'; target[db.insert(knowledge).values({})]++;",
    ],
    ['callee expression', "import { db } from '@/db/client'; (db.insert(knowledge).values({}))();"],
    [
      'computed callee key',
      "import { db } from '@/db/client'; obj[db.insert(knowledge).values({})]();",
    ],
    [
      'parameter initializer',
      "import { db } from '@/db/client'; function f(x = db.insert(knowledge).values({})) {}",
    ],
    [
      'computed object method key',
      "import { db } from '@/db/client'; const x = { [db.insert(knowledge).values({})]() {} };",
    ],
    [
      'computed class method key',
      "import { db } from '@/db/client'; class X { [db.insert(knowledge).values({})]() {} }",
    ],
    [
      'computed binding key',
      "import { db } from '@/db/client'; const {[db.insert(knowledge).values({})]: x} = obj;",
    ],
    [
      'catch default pattern',
      "import { db } from '@/db/client'; try { throw value; } catch ({x = db.insert(knowledge).values({})}) {}",
    ],
    [
      'static block cleanup',
      "import { db } from '@/db/client'; class X { static { const db = cache; } write() { db.insert(knowledge).values({}); } }",
    ],
    [
      'namespace cleanup',
      "import { db } from '@/db/client'; namespace X { const db = cache; } db.insert(knowledge).values({});",
    ],
    [
      'nested namespace cleanup',
      "import { db } from '@/db/client'; namespace X { namespace Y { const db = cache; } } db.insert(knowledge).values({});",
    ],
    [
      'switch cleanup',
      "import { db } from '@/db/client'; switch(x) { case 1: const db = cache; break; } db.insert(knowledge).values({});",
    ],
    [
      'generic trusted alias',
      "import type { Tx } from '@/db/client'; type A<T> = T; function f(x: A<Tx>) { x.insert(knowledge).values({}); }",
    ],
    [
      'branch trusted path',
      "import { db } from '@/db/client'; let client = db; if (condition) client = cache; client.insert(knowledge).values({});",
    ],
    [
      'inverse branch trusted path',
      "import { db } from '@/db/client'; let client = cache; if (condition) client = db; client.insert(knowledge).values({});",
    ],
  ])('YUK-746 exhaustive traversal: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/exhaustive-positive.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    [
      'static block shadow',
      "import { db } from '@/db/client'; class X { static { const db = cache; db.insert(knowledge).values({}); } }",
    ],
    [
      'later switch case shadow',
      "import { db } from '@/db/client'; switch(x) { case 1: db.insert(knowledge).values({}); break; case 2: const db = cache; }",
    ],
    [
      'type parameter shadow',
      "import type { Db } from '@/db/client'; function f<Db extends Writer>(x: Db) { x.insert(knowledge).values({}); }",
    ],
    [
      'class type parameter shadow',
      "import type { Db } from '@/db/client'; class X<Db> { f(x: Db) { x.insert(knowledge).values({}); } }",
    ],
    [
      'namespace type parameter shadow',
      "import type * as Repository from '@/db/client'; function f<Repository>(x: Repository.Tx) { x.insert(knowledge).values({}); }",
    ],
    [
      'parameter property shadow',
      "import { db } from '@/db/client'; class X { constructor(public db: Cache) { db.insert(knowledge).values({}); } }",
    ],
    [
      'generic untrusted alias',
      "import type { Db } from '@/db/client'; type A<Db> = Db; function f(x: A<Cache>) { x.insert(knowledge).values({}); }",
    ],
    [
      'branch no trusted path',
      "import { db } from '@/db/client'; let client = cache; if (condition) client = other; else client = cache; client.insert(knowledge).values({});",
    ],
  ])('YUK-746 exhaustive traversal: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/exhaustive-negative.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it('YUK-746 AST: fails closed on parse failure', async () => {
    const root = fixtureRepo({ 'src/invalid.ts': 'function {' });
    await expect(auditHubSyncWriters({ root, allowlist: emptyAllowlist })).rejects.toThrow(
      'cannot parse src/invalid.ts',
    );
  });

  it('YUK-746 review follow-up: preserves UTF-16 line and excerpt alignment', async () => {
    const root = fixtureRepo({
      'src/unicode-writer.ts':
        "// non-BMP: 🧭\nimport type { Tx } from '@/db/client';\nfunction write(dbOrTx: Tx) { dbOrTx.insert(knowledge).values({}); }",
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual({
      rule: 'UNINVENTORIED_TOPOLOGY_WRITER',
      file: 'src/unicode-writer.ts',
      line: 3,
      excerpt: 'function write(dbOrTx: Tx) { dbOrTx.insert(knowledge).values({}); }',
    });
  });

  it.each([
    ['ordinary template text', 'const text = `db.insert(knowledge) ${"still text"}`;'],
    ['string in interpolation', 'const text = `${"db.insert(knowledge)"}`;'],
    ['comment in interpolation', 'const text = `${/* db.insert(knowledge) */ value}`;'],
    [
      'regex literal',
      'const patterns = [/db.insert(knowledge)/, /update knowledge/, /[\\/]db\\.delete/];',
    ],
    ['unrelated receiver', 'formatter.insert(knowledge);'],
    ['chained formatter API', 'formatter.insert(knowledge).values({});'],
    ['chained cache API', 'cache.update(knowledge).set({});'],
    ['chained collection API', 'collection.delete(knowledge).where(ok);'],
    [
      'untyped db-shaped alias',
      'const repositoryDb = client; repositoryDb.insert(knowledge).values({});',
    ],
    [
      'unrelated typed client',
      "import type { S3Client } from '@aws-sdk/client-s3'; function write(client: S3Client) { client.insert(knowledge).values({}); }",
    ],
    [
      'shadowed imported database',
      "import { db as client } from '@/db/client'; import type { S3Client } from '@aws-sdk/client-s3'; function write(client: S3Client) { client.insert(knowledge).values({}); }",
    ],
    ['unrecognized SQL tag', 'html`update knowledge set name = ${value}`;'],
  ])('YUK-746 review: ignores %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/non-writer.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['optional receiver insert', 'db?.insert(knowledge).values({})'],
    ['optional receiver and call insert', 'db?.insert?.(knowledge).values({})'],
    ['optional receiver update', 'db?.update(knowledge).set({})'],
    ['optional receiver delete', 'db?.delete(knowledge).where(condition)'],
  ])('YUK-746 round 2: catches %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/optional-writer.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['if body', 'if (ok) /db.insert(knowledge)/.test(text);'],
    ['while body', 'while (next()) /update knowledge/.test(text);'],
  ])('YUK-746 round 2: ignores regex literal used as %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/control-flow-regex.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['after if condition', 'if (ok) db.insert(knowledge).values({});'],
    ['after while condition', 'while (next()) db.update(knowledge).set({});'],
  ])('YUK-746 round 2: still catches executable write %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/control-flow-write.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['if string condition', 'if (fn(")")) /db.insert(knowledge)/.test(x);'],
    ['if regex condition', 'if (/[(]/.test(x)) /db.insert(knowledge)/.test(x);'],
    ['for string condition', 'for (; fn(")");) /update knowledge/.test(x);'],
  ])('YUK-746 round 3: ignores regex after %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/literal-condition-regex.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['if string condition', 'if (fn(")")) db.insert(knowledge).values({});'],
    ['if regex condition', 'if (/[(]/.test(x)) db.update(knowledge).set({});'],
    ['for string condition', 'for (; fn(")");) db.delete(knowledge).where(condition);'],
  ])('YUK-746 round 3: catches real write after %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/literal-condition-write.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['plain SQL delimiter', 'if (sql`select )`) /db.insert(knowledge)/.test(x);'],
    [
      'nested SQL interpolation delimiter',
      'if (sql`select ${fn(")")} from values`) /db.insert(knowledge)/.test(x);',
    ],
    ['nested tagged SQL delimiter', 'if (sql`select ${sql`(`}`) /update knowledge/.test(x);'],
  ])('YUK-746 final: ignores regex after %s condition', async (_name, source) => {
    const root = fixtureRepo({ 'src/sql-condition-regex.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['plain SQL delimiter', 'if (sql`select )`) db.insert(knowledge).values({});'],
    [
      'nested SQL interpolation delimiter',
      'if (sql`select ${fn(")")} from values`) db.update(knowledge).set({});',
    ],
    ['nested tagged SQL delimiter', 'if (sql`select ${sql`(`}`) db.delete(knowledge).where(ok);'],
  ])('YUK-746 final: catches real write after %s condition', async (_name, source) => {
    const root = fixtureRepo({ 'src/sql-condition-write.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it('YUK-746 review: detects raw SQL only in recognized SQL tags', async () => {
    const root = fixtureRepo({
      'src/raw.ts': withDb('db.execute(sql`update knowledge set name = ${value}`);'),
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['delete', "db.execute(sql.raw('delete from knowledge where id = 1'));"],
    ['insert', "db.execute(sql.raw('insert into knowledge_edge (id) values (1)'));"],
    ['update', "db.execute(sql.raw('update knowledge set name = x'));"],
  ])('YUK-746 P2: detects sql.raw %s writes', async (_name, source) => {
    const root = fixtureRepo({ 'src/sql-raw-writer.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
    expect(findings).toHaveLength(1);
  });

  it('YUK-746 P2: propagates immutable raw SQL constants', async () => {
    const root = fixtureRepo({
      'src/sql-raw-constant.ts': withDb(
        "const q = 'delete from knowledge'; db.execute(sql.raw(q));",
      ),
      'src/sql-raw-constant-safe.ts': withDb(
        'const q = `select * from knowledge`; db.execute(sql.raw(q));',
      ),
      'src/sql-raw-constant-foreign.ts': withDb(
        "const q = 'delete from knowledge'; cache.execute(sql.raw(q));",
      ),
    });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([
      expect.objectContaining({
        file: 'src/sql-raw-constant.ts',
        rule: 'UNINVENTORIED_TOPOLOGY_WRITER',
      }),
    ]);
  });

  it('YUK-746 blocker: propagates stored tagged SQL until reassignment', async () => {
    const root = fixtureRepo({
      'src/sql-tagged-stored.ts': withDb(
        'const stmt = sql`delete from knowledge`; db.execute(stmt);',
      ),
      'src/sql-tagged-reassigned-before.ts': withDb(
        'let stmt = sql`delete from knowledge`; stmt = safeQuery; db.execute(stmt);',
      ),
      'src/sql-tagged-reassigned-after.ts': withDb(
        'let stmt = sql`delete from knowledge`; db.execute(stmt); stmt = safeQuery;',
      ),
      'src/sql-tagged-safe.ts': withDb(
        'const stmt = sql`select * from knowledge`; db.execute(stmt);',
      ),
      'src/sql-tagged-foreign.ts': withDb(
        'const stmt = sql`delete from knowledge`; cache.execute(stmt);',
      ),
    });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([
      expect.objectContaining({
        file: 'src/sql-tagged-reassigned-after.ts',
        rule: 'UNINVENTORIED_TOPOLOGY_WRITER',
      }),
      expect.objectContaining({
        file: 'src/sql-tagged-stored.ts',
        rule: 'UNINVENTORIED_TOPOLOGY_WRITER',
      }),
    ]);
  });

  it('YUK-746 blocker: propagates stored tagged SQL internal markers until reassignment', async () => {
    const root = fixtureRepo({
      'src/sql-tagged-marker.ts': withDb(
        "const stmt = sql`set local app.hub_sync_internal_apply = '1'`; db.execute(stmt);",
      ),
      'src/sql-tagged-marker-reassigned-before.ts': withDb(
        "let stmt = sql`set local app.hub_sync_internal_apply = '1'`; stmt = safeQuery; db.execute(stmt);",
      ),
      'src/sql-tagged-marker-reassigned-after.ts': withDb(
        "let stmt = sql`set local app.hub_sync_internal_apply = '1'`; db.execute(stmt); stmt = safeQuery;",
      ),
    });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([
      expect.objectContaining({
        file: 'src/sql-tagged-marker-reassigned-after.ts',
        rule: 'INTERNAL_APPLY_MARKER_BYPASS',
      }),
      expect.objectContaining({
        file: 'src/sql-tagged-marker.ts',
        rule: 'INTERNAL_APPLY_MARKER_BYPASS',
      }),
    ]);
  });

  it('YUK-746 review: propagates immutable internal marker constants only through trusted execute', async () => {
    const root = fixtureRepo({
      'src/sql-raw-marker-constant.ts': withDb(
        'const marker = "set local app.hub_sync_internal_apply = \'1\'"; db.execute(sql.raw(marker));',
      ),
      'src/sql-raw-marker-constant-foreign.ts': withDb(
        'const marker = "set local app.hub_sync_internal_apply = \'1\'"; cache.execute(sql.raw(marker));',
      ),
      'src/sql-raw-marker-let.ts': withDb(
        'let marker = "set local app.hub_sync_internal_apply = \'1\'"; db.execute(sql.raw(marker));',
      ),
      'src/sql-raw-marker-reassigned.ts': withDb(
        "let marker = \"set local app.hub_sync_internal_apply = '1'\"; marker = 'select 1'; db.execute(sql.raw(marker));",
      ),
      'src/sql-raw-marker-reassigned-before.ts': withDb(
        "const marker = \"set local app.hub_sync_internal_apply = '1'\"; marker = 'select 1'; db.execute(sql.raw(marker));",
      ),
      'src/sql-raw-marker-reassigned-after.ts': withDb(
        "const marker = \"set local app.hub_sync_internal_apply = '1'\"; db.execute(sql.raw(marker)); marker = 'select 1';",
      ),
      'src/sql-raw-marker-updated-before.ts': withDb(
        'const marker = "set local app.hub_sync_internal_apply = \'1\'"; marker++; db.execute(sql.raw(marker));',
      ),
      'src/sql-raw-marker-updated-after.ts': withDb(
        'const marker = "set local app.hub_sync_internal_apply = \'1\'"; db.execute(sql.raw(marker)); marker++;',
      ),
      'src/sql-raw-ordinary-constant.ts': withDb(
        "const marker = 'select app.hub_sync_status'; db.execute(sql.raw(marker));",
      ),
    });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'src/sql-raw-marker-constant.ts',
          rule: 'INTERNAL_APPLY_MARKER_BYPASS',
        }),
        expect.objectContaining({
          file: 'src/sql-raw-marker-reassigned-after.ts',
          rule: 'INTERNAL_APPLY_MARKER_BYPASS',
        }),
        expect.objectContaining({
          file: 'src/sql-raw-marker-updated-after.ts',
          rule: 'INTERNAL_APPLY_MARKER_BYPASS',
        }),
      ]),
    );
  });

  it('YUK-746 P2: detects internal marker inside sql.raw', async () => {
    const root = fixtureRepo({
      'src/sql-raw-marker.ts': withDb(
        'db.execute(sql.raw("set local app.hub_sync_internal_apply = \'1\'"));',
      ),
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'INTERNAL_APPLY_MARKER_BYPASS' }),
    );
  });

  it.each([
    ['ordinary string', "const value = 'delete from knowledge';"],
    ['control delimiter', "if (sql.raw('select )')) /db.insert(knowledge)/.test(x);"],
  ])('YUK-746 P2: keeps %s masked', async (_name, source) => {
    const root = fixtureRepo({ 'src/sql-raw-non-writer.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it('YUK-746 P2: catches real write after sql.raw delimiter condition', async () => {
    const root = fixtureRepo({
      'src/sql-raw-control-write.ts': withDb(
        "if (sql.raw('select )')) db.insert(knowledge).values({});",
      ),
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['static template', 'db.execute(sql.raw(`delete from knowledge`));'],
    ['multiline template', 'db.execute(sql.raw(`insert into\nknowledge_edge (id) values (1)`));'],
    ['escaped backtick', 'db.execute(sql.raw(`update knowledge set name = \\`x\\``));'],
  ])('YUK-746 P2 follow-up: detects sql.raw %s writes', async (_name, source) => {
    const root = fixtureRepo({ 'src/sql-raw-template-writer.ts': withDb(source) });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it('YUK-746 P2 follow-up: detects internal marker in sql.raw template', async () => {
    const root = fixtureRepo({
      'src/sql-raw-template-marker.ts': withDb(
        "db.execute(sql.raw(`set local app.hub_sync_internal_apply = '1'`));",
      ),
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'INTERNAL_APPLY_MARKER_BYPASS' }),
    );
  });

  it('YUK-746 P2 follow-up: scans executable sql.raw template interpolation', async () => {
    const root = fixtureRepo({
      'src/sql-raw-template-expression.ts': withDb(
        'db.execute(sql.raw(`select ${db.insert(knowledge).values({})}`));',
      ),
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['comment lookalike', "/* actorRef: */ const value = 'hub_auto_sync';"],
    ['ordinary property lookalike', "const actorRefText = 'hub_auto_sync';"],
  ])('YUK-746 P2 follow-up: ignores %s actor string', async (_name, source) => {
    const root = fixtureRepo({ 'src/actor-string.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['identifier key', "const value = { actorRef: 'hub_auto_sync' };"],
    ['quoted key', 'const value = { "actorRef": "hub_auto_sync" };'],
  ])('YUK-746 P2 follow-up: detects real %s actor value', async (_name, source) => {
    const root = fixtureRepo({ 'src/actor-value.ts': source });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(expect.objectContaining({ rule: 'DIRECT_HUB_ACTOR_APPLY' }));
  });

  it('YUK-746 review: scans production audit-prefixed files', async () => {
    const root = fixtureRepo({
      'scripts/audit-production.ts': withDb('db.insert(knowledge).values({});'),
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'scripts/audit-production.ts' }),
    );
  });

  describe('YUK-746 bounded may-trust dataflow matrix', () => {
    const positiveCases = [
      [
        'stable var hoist binding',
        'function f(){ client = db; var client; client.insert(knowledge).values({}); }',
      ],
      [
        'uninitialized let is definitely undefined after declaration',
        'let client; ((value = db) => value.insert(knowledge).values({}))(client);',
      ],
      [
        'uninitialized var is definitely undefined after declaration',
        'var client; ((value = db) => value.insert(knowledge).values({}))(client);',
      ],
      [
        'hoisted var is definitely undefined before declaration',
        '((value = db) => value.insert(knowledge).values({}))(client); var client;',
      ],
      [
        'later var initializer replaces hoisted undefined',
        'var client = db; client.insert(knowledge).values({});',
      ],
      [
        'conditional assignment joins hoisted undefined with trust',
        'var client; if (condition) client = db; client?.insert(knowledge).values({});',
      ],
      [
        'callee snapshot before argument reassignment',
        'let client = db; client.insert((client = cache, knowledge)).values({});',
      ],
      [
        'self assignment reports before clearing',
        'let client = db; client = client.insert(knowledge).values({});',
      ],
      [
        'computed lhs before rhs',
        'let client = db; target[client.insert(knowledge).values({})] = (client = cache);',
      ],
      [
        'declarator initializer before computed pattern key',
        'let client = cache; const {[client.insert(knowledge).values({})]: x} = (client = db, obj);',
      ],
      [
        'sequence and await ordering',
        'let client = db; async function f(){ (await client.insert(knowledge).values({}), client = cache); }',
      ],
      [
        'ternary trusted branch',
        'let client = cache; condition ? client = db : client = cache; client.insert(knowledge).values({});',
      ],
      [
        'logical rhs creates trust',
        'let client = cache; condition && (client = db); client.insert(knowledge).values({});',
      ],
      [
        'logical assignment skip retains trust',
        'let client = db; client &&= cache; client.insert(knowledge).values({});',
      ],
      [
        'optional argument side effect joins',
        'let client = db; client?.transaction?.(client = cache); client.insert(knowledge).values({});',
      ],
      [
        'while zero path retains trust',
        'let client = db; while (condition) client = cache; client.insert(knowledge).values({});',
      ],
      [
        'while condition sets trust on zero path',
        'let client = cache; while ((client = db, false)) {} client.insert(knowledge).values({});',
      ],
      [
        'for zero path retains trust',
        'let client = db; for (; condition; ) client = cache; client.insert(knowledge).values({});',
      ],
      [
        'do body executes once',
        'let client = cache; do { client = db; } while (false); client.insert(knowledge).values({});',
      ],
      [
        'arrow closure capture after assignment',
        'let client = cache; const f = () => client.insert(knowledge).values({}); client = db; f();',
      ],
      [
        'declaration closure capture after assignment',
        'let client = cache; function f(){ client.insert(knowledge).values({}); } client = db; f();',
      ],
      [
        'escaping declaration ignores unreachable syntactic call',
        'function outer(){ function f(){ db.insert(knowledge).values({}); } return f; f(); } outer();',
      ],
      [
        'declaration fallback ignores post-throw syntactic call',
        'function outer(){ function f(){ db.insert(knowledge).values({}); } throw boom; f(); } outer();',
      ],
      [
        'call throw frontier before argument mutation',
        'let client = db; try { client.method(client = cache); } catch { client.insert(knowledge).values({}); }',
      ],
      [
        'computed call throw frontier before argument mutation',
        'let client = db; try { client[key](client = cache); } catch { client.insert(knowledge).values({}); }',
      ],
      [
        'chained label continue reaches update',
        'let client = cache; outer: inner: for (; condition; client = db) { continue outer; } client.insert(knowledge).values({});',
      ],
      [
        'for-of zero path retains trust',
        'let client = db; for (const x of values) client = cache; client.insert(knowledge).values({});',
      ],
      [
        'loop backedge gains trust',
        'let client = cache; while (condition) { client = db; continue; } client.insert(knowledge).values({});',
      ],
      [
        'continue reaches for update',
        'let client = cache; for (; condition; client = db) { continue; } client.insert(knowledge).values({});',
      ],
      [
        'break exit carries trust',
        'let client = cache; while (condition) { client = db; break; } client.insert(knowledge).values({});',
      ],
      [
        'labeled outer continue',
        'let client = cache; outer: for (; condition; client = db) { for (;;) continue outer; } client.insert(knowledge).values({});',
      ],
      [
        'switch independent trusted direct case',
        'let client = cache; switch(x){ case (client = db, 1): break; case 2: client.insert(knowledge).values({}); }',
      ],
      [
        'switch fallthrough',
        'let client = cache; switch(x){ case 1: client = db; case 2: client.insert(knowledge).values({}); }',
      ],
      [
        'switch default middle',
        'let client = cache; switch(x){ default: client = db; case 2: client.insert(knowledge).values({}); }',
      ],
      [
        'post switch merge',
        'let client = cache; switch(x){ case 1: client = db; break; default: client = cache; } client.insert(knowledge).values({});',
      ],
      [
        'explicit throw catch path',
        'let client = cache; try { client = db; throw boom; } catch { client.insert(knowledge).values({}); }',
      ],
      [
        'potential throw catch path',
        'let client = db; try { client.prop; client = cache; } catch { client.insert(knowledge).values({}); }',
      ],
      [
        'catch default effects',
        'try { throw value; } catch ({x = db.insert(knowledge).values({})}) {}',
      ],
      [
        'finally transforms return path',
        'function f(){ let client = cache; try { client = db; return; } finally { client.insert(knowledge).values({}); } }',
      ],
      [
        'finally transforms throw path',
        'let client = cache; try { client = db; throw boom; } finally { client.insert(knowledge).values({}); }',
      ],
      [
        'nested try provenance',
        'let client = cache; try { try { client = db; throw boom; } finally {} } catch { client.insert(knowledge).values({}); }',
      ],
      [
        'unreachable after finally override ignored but final write found',
        'function f(){ try { return; } finally { db.insert(knowledge).values({}); throw boom; } db.update(knowledge_edge).set({}); }',
      ],
      [
        'generic default typeof db',
        'type A<T = typeof db> = T; function f(client: A){ client.insert(knowledge).values({}); }',
      ],
      [
        'chained generic defaults',
        'type A<T = typeof db, U = T> = U; function f(client: A){ client.insert(knowledge).values({}); }',
      ],
      [
        'union nullish default',
        'type A<T = typeof db | undefined> = T; function f(client: A){ client?.insert(knowledge).values({}); }',
      ],
      [
        'destructured trusted intersection property',
        "import type { Db } from '@/db/client'; type Props = { db: Db } & { cache: Cache }; function f({ db }: Props) { db.insert(knowledge).values({}); }",
      ],
      ['computed string insert', "db['insert'](knowledge).values({});"],
      ['computed string update', "db['update'](knowledge_edge).set({});"],
      ['computed string delete', "db['delete'](knowledge_edge).where(condition);"],
      ['inline arrow invocation', '(()=>db.insert(knowledge).values({}))();'],
      ['inline arrow positional argument', '((client)=>client.insert(knowledge).values({}))(db);'],
      [
        'inline function positional argument',
        '(function(client){ client.insert(knowledge).values({}); })(db);',
      ],
      ['inline function invocation', '(function(){ db.update(knowledge_edge).set({}); })();'],
      [
        'inline default parameter',
        '((client = db) => client.delete(knowledge).where(condition))();',
      ],
      [
        'explicit undefined takes trusted default',
        '((client = db) => client.insert(knowledge).values({}))(undefined);',
      ],
      [
        'maybe undefined joins trusted default',
        '((client = db) => client.insert(knowledge).values({}))(condition ? cache : undefined);',
      ],
      [
        'logical maybe undefined joins trusted default',
        '((client = db) => client.insert(knowledge).values({}))(condition && undefined);',
      ],
      [
        'unbound global undefined takes trusted default',
        '((client = db) => client.insert(knowledge).values({}))(undefined);',
      ],
      [
        'inline argument side effect before invocation',
        'let client = cache; ((value)=>client.insert(knowledge).values({}))((client = db));',
      ],
      [
        'dynamic repo db import',
        "async function f(){ const { db: client } = await import('@/db/client'); client.insert(knowledge).values({}); } f();",
      ],
      [
        'dynamic repo db import typed binding',
        "async function f(){ const { db }: { db: import('@/db/client').Db } = await import('@/db/client'); db.update(knowledge_edge).set({}); } f();",
      ],
      [
        'dynamic import evaluates source expression',
        'async function f(){ await import((db.insert(knowledge).values({}), path)); } f();',
      ],
      ['IIFE return resumes caller', '(function(){ return; })(), db.insert(knowledge).values({});'],
      ['TS export assignment expression', 'export = db.delete(knowledge).where(condition);'],
    ] as const;

    it.each(positiveCases)('detects %s', async (_name, body) => {
      const root = fixtureRepo({ 'src/dataflow-positive.ts': withDb(body) });
      expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toContainEqual(
        expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
      );
    });

    const negativeCases = [
      [
        'nested shadow',
        'let client = db; { let client = cache; client.insert(knowledge).values({}); }',
      ],
      [
        'assignment after uninitialized let replaces undefined',
        'let client; client = cache; client.insert(knowledge).values({});',
      ],
      [
        'reassignment clears trust',
        'let client = db; client = cache; client.insert(knowledge).values({});',
      ],
      [
        'callee argument cannot invent receiver trust',
        'let client = cache; client.insert((client = db, knowledge)).values({});',
      ],
      [
        'computed lhs clears before rhs',
        'let client = db; target[(client = cache)] = client.insert(knowledge).values({});',
      ],
      [
        'logical rhs all untrusted',
        'let client = cache; condition && (client = other); client.insert(knowledge).values({});',
      ],
      [
        'while body remains foreign',
        'let client = cache; while (condition) client = other; client.insert(knowledge).values({});',
      ],
      [
        'while condition clears trust before zero exit',
        'let client = db; while ((client = cache, false)) {} client.insert(knowledge).values({});',
      ],
      [
        'for body remains foreign',
        'let client = cache; for (; condition; ) client = other; client.insert(knowledge).values({});',
      ],
      [
        'do clears before post flow',
        'let client = db; do { client = cache; } while (false); client.insert(knowledge).values({});',
      ],
      [
        'arrow closure cleared before invocation',
        'let client = db; const f = () => client.insert(knowledge).values({}); client = cache; f();',
      ],
      [
        'declaration closure cleared before invocation',
        'let client = db; function f(){ client.insert(knowledge).values({}); } client = cache; f();',
      ],
      [
        'foreign escaping declaration ignores unreachable call',
        'function outer(){ function f(){ cache.insert(knowledge).values({}); } return f; f(); } outer();',
      ],
      [
        'foreign declaration fallback ignores post-throw call',
        'function outer(){ function f(){ cache.insert(knowledge).values({}); } throw boom; f(); } outer();',
      ],
      [
        'foreign call throw frontier remains clean',
        'let client = cache; try { client.method(client = other); } catch { client.insert(knowledge).values({}); }',
      ],
      [
        'chained label foreign update remains clean',
        'let client = cache; outer: inner: for (; condition; client = other) { continue outer; } client.insert(knowledge).values({});',
      ],
      [
        'for-of remains foreign',
        'let client = cache; for (const x of values) client = other; client.insert(knowledge).values({});',
      ],
      ['unreachable after return', 'function f(){ return; db.insert(knowledge).values({}); }'],
      ['unreachable after throw', 'function f(){ throw boom; db.insert(knowledge).values({}); }'],
      ['unreachable after break', 'while (condition){ break; db.insert(knowledge).values({}); }'],
      [
        'unreachable after continue',
        'while (condition){ continue; db.insert(knowledge).values({}); }',
      ],
      [
        'switch broken case does not poison direct case',
        'let client = cache; switch(x){ case 1: client = db; break; case 2: client.insert(knowledge).values({}); }',
      ],
      [
        'switch foreign fallthrough',
        'let client = cache; switch(x){ case 1: client = other; case 2: client.insert(knowledge).values({}); }',
      ],
      [
        'try and catch both foreign',
        'let client = cache; try { client.prop; } catch { client = other; } client.insert(knowledge).values({});',
      ],
      [
        'finally abrupt makes later code unreachable',
        'function f(){ try { return; } finally { throw boom; } db.insert(knowledge).values({}); }',
      ],
      [
        'explicit cache generic override',
        'type A<T = typeof db> = T; function f(client: A<Cache>){ client.insert(knowledge).values({}); }',
      ],
      [
        'omitted required generic',
        'type A<T> = T; function f(client: A){ client.insert(knowledge).values({}); }',
      ],
      [
        'recursive alias',
        'type A<T = Cache> = A<T>; function f(client: A){ client.insert(knowledge).values({}); }',
      ],
      [
        'namespace shadow',
        "import type * as Repository from '@/db/client'; function f<Repository>(client: Repository.Tx){ client.insert(knowledge).values({}); }",
      ],
      ['foreign computed string insert', "cache['insert'](knowledge).values({});"],
      ['foreign computed string update', "cache['update'](knowledge_edge).set({});"],
      ['foreign computed string delete', "cache['delete'](knowledge_edge).where(condition);"],
      ['foreign inline arrow invocation', '(()=>cache.insert(knowledge).values({}))();'],
      [
        'foreign argument suppresses trusted default',
        '((client=db)=>client.insert(knowledge).values({}))(cache);',
      ],
      [
        'foreign conditional suppresses trusted default',
        '((client=db)=>client.insert(knowledge).values({}))(condition ? cache : other);',
      ],
      [
        'foreign logical result suppresses trusted default',
        '((client=db)=>client.insert(knowledge).values({}))(cache || other);',
      ],
      [
        'shadowed undefined carries foreign value',
        'function outer(undefined){ ((client=db)=>client.insert(knowledge).values({}))(undefined); } outer(cache);',
      ],
      [
        'throwing argument stops IIFE body',
        '((client)=>db.insert(knowledge).values({}))((()=>{ throw error; })());',
      ],
      [
        'foreign inline function invocation',
        '(function(){ cache.update(knowledge_edge).set({}); })();',
      ],
      ['inline abrupt before write', '(()=>{ throw error; db.insert(knowledge).values({}); })();'],
      ['throwing IIFE stops caller', '(()=>{ throw error; })(), db.insert(knowledge).values({});'],
      [
        'dynamic import abrupt source stops caller',
        'async function f(){ await import((()=>{ throw error; })()); db.insert(knowledge).values({}); } f();',
      ],
      [
        'foreign dynamic db import',
        "async function f(){ const { db: client } = await import('@/cache/client'); client.insert(knowledge).values({}); } f();",
      ],
      [
        'dynamic repo import non-db property',
        "async function f(){ const { cache } = await import('@/db/client'); cache.insert(knowledge).values({}); } f();",
      ],
    ] as const;

    it.each(negativeCases)('ignores %s', async (_name, body) => {
      const root = fixtureRepo({ 'src/dataflow-negative.ts': withDb(body) });
      expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
    });

    it('scans inline callbacks passed to ordinary calls without trusting callback parameters', async () => {
      const root = fixtureRepo({
        'src/callbacks.ts': withDb(`
          register(() => db.insert(knowledge).values({}));
          register(function () { db.update(knowledge_edge).set({}); });
          register((client) => client.delete(knowledge).where(condition));
        `),
      });
      const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
      expect(findings).toHaveLength(2);
    });

    it('preserves property trust through generic interfaces and honors scoped shadowing', async () => {
      const root = fixtureRepo({
        'src/interfaces.ts': withDb(`
          import type { Db } from '@/db/client';
          interface Deps<T = Db> { db: T }
          function write({ db: client }: Deps) { client.insert(knowledge).values({}); }
          function skip<Deps>({ db: client }: Deps) { client.update(knowledge_edge).set({}); }
        `),
      });
      const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
      expect(findings).toHaveLength(1);
    });

    it('unwraps angle-bracket TypeScript assertions', async () => {
      const root = fixtureRepo({
        'src/assertion.ts': withDb('(<typeof db>db).insert(knowledge).values({});'),
      });
      await expect(auditHubSyncWriters({ root, allowlist: emptyAllowlist })).resolves.toEqual([
        expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
      ]);
    });

    it('deduplicates only AST and lexical overlap while preserving distinct same-line writes', async () => {
      const root = fixtureRepo({
        'src/duplicates.ts': withDb(
          `db.execute(sql.raw("update knowledge set name = 'x'")); db.execute(sql.raw("delete from knowledge")); db.execute(sql.raw("set local app.hub_sync_internal_apply = '1'"));`,
        ),
      });
      const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
      expect(
        findings.filter((finding) => finding.rule === 'UNINVENTORIED_TOPOLOGY_WRITER'),
      ).toHaveLength(2);
      expect(
        findings.filter((finding) => finding.rule === 'INTERNAL_APPLY_MARKER_BYPASS'),
      ).toHaveLength(1);
    });

    it('evaluates enum initializers and safely accepts import-equals declarations', async () => {
      const root = fixtureRepo({
        'src/ts-declarations.ts': withDb(`
          import fs = require('node:fs');
          enum Writes { Value = db.insert(knowledge).values({}) as unknown as number }
        `),
      });
      await expect(auditHubSyncWriters({ root, allowlist: emptyAllowlist })).resolves.toEqual([
        expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
      ]);
    });

    it('shadows trusted db with enum and import-equals value declarations', async () => {
      const root = fixtureRepo({
        'src/enum-shadow.ts': `
          import { db as trustedDb } from '${'@/db/' + 'client'}';
          enum db { Value = trustedDb.insert(knowledge).values({}) as unknown as number }
          db.update(knowledge_edge).set({});
        `,
        'src/import-equals-shadow.ts': `
          import { db as trustedDb } from '${'@/db/' + 'client'}';
          import db = require('@/cache/client');
          db.update(knowledge_edge).set({});
          trustedDb.insert(knowledge).values({});
        `,
        'src/import-equals-alias.ts': `
          import { db as trustedDb } from '${'@/db/' + 'client'}';
          import db = Cache.db;
          db.delete(knowledge).where(condition);
          trustedDb.insert(knowledge).values({});
        `,
      });
      const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
      expect(findings).toHaveLength(3);
      expect(findings.every((finding) => finding.excerpt.includes('trustedDb.'))).toBe(true);
    });

    it('preserves interface inheritance, generics, declaration merging, and scoped shadowing', async () => {
      const root = fixtureRepo({
        'src/interface-inheritance.ts': withDb(`
          import type { Db } from '@/db/client';
          interface Base<T> { db: T }
          interface Mid<T> extends Base<T> {}
          interface Deps extends Mid<Db> {}
          interface Merged {}
          interface Merged { db: Db }
          function inherited({ db: client }: Deps) { client.insert(knowledge).values({}); }
          function merged({ db: client }: Merged) { client.update(knowledge_edge).set({}); }
          function shadow<Deps>({ db: client }: Deps) { client.delete(knowledge).where(condition); }
        `),
      });
      const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
      expect(findings).toHaveLength(2);
    });

    it('fails safe for conflicting merged interface properties and inheritance cycles', async () => {
      const root = fixtureRepo({
        'src/interface-conflicts.ts': withDb(`
          import type { Db } from '@/db/client';
          interface Conflict { db: Db }
          interface Conflict { db: Cache }
          interface CycleA extends CycleB { db: Db }
          interface CycleB extends CycleA {}
          function conflict({ db: client }: Conflict) { client.insert(knowledge).values({}); }
          function cycle({ db: client }: CycleB) { client.update(knowledge_edge).set({}); }
        `),
      });
      expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
    });

    it('fails closed on an unsupported executable AST node', async () => {
      const root = fixtureRepo({
        'src/unsupported.ts': withDb('const value = module { export const x = 1 };'),
      });
      await expect(auditHubSyncWriters({ root, allowlist: emptyAllowlist })).rejects.toThrow(
        /unsupported executable|cannot parse/,
      );
    });
  });

  it('YUK-746 RED: runs as a CLI from a URL-significant path', () => {
    const specialRoot = mkdtempSync(join(resolve(__dirname, '..'), '.hub sync %'));
    fixtures.push(specialRoot);
    mkdirSync(join(specialRoot, 'scripts'), { recursive: true });
    const source = readFileSync(resolve(__dirname, 'audit-hub-sync-writers.ts'), 'utf8');
    const dataflow = readFileSync(resolve(__dirname, 'hub-sync-writer-dataflow.ts'), 'utf8');
    writeFileSync(join(specialRoot, 'scripts/audit-hub-sync-writers.ts'), source);
    writeFileSync(join(specialRoot, 'scripts/hub-sync-writer-dataflow.ts'), dataflow);
    writeFileSync(
      join(specialRoot, 'scripts/audit-hub-sync-writers-allowlist.json'),
      '{"writers":[]}',
    );
    symlinkSync(resolve(__dirname, '../node_modules'), join(specialRoot, 'node_modules'));

    const result = spawnSync(
      resolve(__dirname, '../node_modules/.bin/tsx'),
      [join(specialRoot, 'scripts/audit-hub-sync-writers.ts')],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toContain('Hub sync writer audit passed');
  });
});
