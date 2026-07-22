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
    const root = fixtureRepo({ 'src/bypass.ts': source });
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
    const root = fixtureRepo({ 'src/multiline.ts': source });
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
    ['transaction receiver', 'tx.update(knowledge).set({})'],
    ['nested template expression', 'const value = `ignored ${`also ${db.delete(knowledge)}`}`'],
  ])('YUK-746 review: catches %s Drizzle syntax', async (_name, source) => {
    const root = fixtureRepo({ 'src/writer.ts': source });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
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
    const root = fixtureRepo({ 'src/optional-writer.ts': source });
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
    const root = fixtureRepo({ 'src/control-flow-write.ts': source });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it.each([
    ['if string condition', 'if (fn(")")) /db.insert(knowledge)/.test(x);'],
    ['if regex condition', 'if (/[(]/.test(x)) /db.insert(knowledge)/.test(x);'],
    ['for string condition', 'for (; fn(")");) /update knowledge/.test(x);'],
    ['with regex condition', 'with (/[(]/.exec(x)) /db.insert(knowledge)/.test(x);'],
  ])('YUK-746 round 3: ignores regex after %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/literal-condition-regex.ts': source });
    expect(await auditHubSyncWriters({ root, allowlist: emptyAllowlist })).toEqual([]);
  });

  it.each([
    ['if string condition', 'if (fn(")")) db.insert(knowledge).values({});'],
    ['if regex condition', 'if (/[(]/.test(x)) db.update(knowledge).set({});'],
    ['for string condition', 'for (; fn(")");) db.delete(knowledge).where(condition);'],
    ['with regex condition', 'with (/[(]/.exec(x)) db.insert(knowledge).values({});'],
  ])('YUK-746 round 3: catches real write after %s', async (_name, source) => {
    const root = fixtureRepo({ 'src/literal-condition-write.ts': source });
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
    const root = fixtureRepo({ 'src/sql-condition-write.ts': source });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it('YUK-746 review: detects raw SQL only in recognized SQL tags', async () => {
    const root = fixtureRepo({
      'src/raw.ts': 'db.execute(sql`update knowledge set name = ${value}`);',
    });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER' }),
    );
  });

  it('YUK-746 review: scans production audit-prefixed files', async () => {
    const root = fixtureRepo({ 'scripts/audit-production.ts': 'db.insert(knowledge).values({});' });
    const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
    expect(findings).toContainEqual(
      expect.objectContaining({ file: 'scripts/audit-production.ts' }),
    );
  });

  it('YUK-746 RED: runs as a CLI from a URL-significant path', () => {
    const specialRoot = mkdtempSync(join(resolve(__dirname, '..'), '.hub sync %'));
    fixtures.push(specialRoot);
    mkdirSync(join(specialRoot, 'scripts'), { recursive: true });
    const source = readFileSync(resolve(__dirname, 'audit-hub-sync-writers.ts'), 'utf8');
    writeFileSync(join(specialRoot, 'scripts/audit-hub-sync-writers.ts'), source);
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
