import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audit } from './audit-schema-writes';

const migrationPath = 'drizzle/0117_yuk1394_session_orphan_backend.sql';
const journalPath = 'drizzle/meta/_journal.json';
const migration = readFileSync(migrationPath, 'utf8');
const journal = readFileSync(journalPath, 'utf8');
const currentSchema = readFileSync('src/db/schema.ts', 'utf8');
const schema = currentSchema.slice(
  currentSchema.indexOf('export const session_orphan_control ='),
  currentSchema.indexOf('export const session_orphan_tick ='),
);
const seed = migration.slice(migration.indexOf('INSERT INTO'), migration.indexOf('-->'));
const firstBatch = migration.split('--> statement-breakpoint')[0];

describe('YUK-1394 registered migration initialization evidence', () => {
  let root: string;
  function write(path: string, source: string) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  function familyResult() {
    return audit(root).results.find(
      (field) => field.table === 'session_orphan_control' && field.field === 'family',
    );
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yuk1394-seed-audit-'));
    write('src/db/schema.ts', schema);
    write(migrationPath, migration);
    write(journalPath, journal);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('recognizes the real registered seed without inventing a runtime INSERT', () => {
    expect(familyResult()).toEqual({
      table: 'session_orphan_control',
      field: 'family',
      type: 'text',
      insert_files: 0,
      update_files: 0,
      status: 'init-only',
      initialization: {
        migration: migrationPath,
        values: ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'],
      },
    });
    // The migration initializes phase too, but only the immutable family field
    // belongs to this contract. Other business fields still need producers.
    expect(audit(root).results).toContainEqual(
      expect.objectContaining({ table: 'session_orphan_control', field: 'phase', status: 'stub' }),
    );
  });

  it.each([migrationPath, journalPath])('fails closed when %s is missing', (path) => {
    rmSync(join(root, path));
    expect(familyResult()).toMatchObject({ status: 'stub', insert_files: 0 });
    expect(familyResult()).not.toHaveProperty('initialization');
  });

  it.each([
    ['malformed JSON', '{'],
    ['missing entries', '{"version":"7","dialect":"postgresql"}'],
    ['unregistered tag', journal.replace('0117_yuk1394_session_orphan_backend', '0117_other')],
    ['wrong index', journal.replace('"idx": 117', '"idx": 118')],
    ['wrong version', journal.replace(/"version": "7"/g, '"version": "6"')],
    ['wrong dialect', journal.replace('"postgresql"', '"sqlite"')],
    ['wrong timestamp', journal.replace('1791504000001', '1791504000002')],
    [
      'breakpoints disabled',
      journal.replace(
        /("tag": "0117_yuk1394_session_orphan_backend",\s*"breakpoints": )true/,
        '$1false',
      ),
    ],
    [
      'registration removed',
      JSON.stringify({
        ...JSON.parse(journal),
        entries: JSON.parse(journal).entries.filter((entry: { idx: number }) => entry.idx !== 117),
      }),
    ],
    [
      'duplicate registration',
      JSON.stringify({
        ...JSON.parse(journal),
        entries: [...JSON.parse(journal).entries, JSON.parse(journal).entries.at(-1)],
      }),
    ],
  ])('rejects %s', (_label, changed) => {
    expect(changed).not.toBe(journal);
    write(journalPath, changed);
    expect(familyResult()).toMatchObject({ status: 'stub', insert_files: 0 });
  });

  it.each([
    ['missing seed', migration.replace(seed, '')],
    ['wrong table', migration.replace('INSERT INTO session_orphan_control', 'INSERT INTO other')],
    ['wrong column', migration.replace('(family,phase) VALUES', '(renamed,phase) VALUES')],
    ['wrong family', migration.replace(/prune_orphan_placement_sessions/g, 'other_family')],
    [
      'wrong seed family only',
      migration.replace(seed, seed.replace('prune_orphan_placement_sessions', 'other_family')),
    ],
    ['wrong phase', migration.replace(seed, seed.replace(/pg-boss/g, 'dbos'))],
    ['one seed row', migration.replace(", ('prune_orphan_placement_sessions','pg-boss')", '')],
    ['extra seed row', migration.replace(seed, seed.replace(';', ", ('other_family','pg-boss');"))],
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
      'SQL function body',
      migration.replace(
        seed,
        `CREATE FUNCTION unused_seed() RETURNS void LANGUAGE SQL AS $$ ${seed} $$;`,
      ),
    ],
    [
      'tagged DO body',
      migration.replace(seed, `DO $seed$ BEGIN IF false THEN ${seed} END IF; END $seed$;`),
    ],
    ['quoted documentation', migration.replace(seed, `SELECT '${seed.replaceAll("'", "''")}';`)],
    ['commented batch', migration.replace(firstBatch, `/* ${firstBatch} */\n`)],
    [
      'unexecuted batch',
      migration.replace(
        firstBatch,
        `CREATE FUNCTION unused_seed() RETURNS void LANGUAGE SQL AS $$ ${firstBatch} $$;\n`,
      ),
    ],
    ['historical later seed', `${migration.replace(seed, '')}\n${seed}`],
  ])('rejects %s instead of matching an INSERT substring', (_label, changed) => {
    expect(changed).not.toBe(migration);
    write(migrationPath, changed);
    expect(familyResult()).toMatchObject({ status: 'stub', insert_files: 0 });
    expect(familyResult()).not.toHaveProperty('initialization');
  });

  it.each([
    ['SQL name', schema.replace("pgTable('session_orphan_control'", "pgTable('other'")],
    ['column name', schema.replace("text('family'", "text('renamed'")],
    ['column type', schema.replace("text('family'", "integer('family'")],
    ['closed family domain', schema.replace('prune_orphan_placement_sessions', 'other_family')],
    [
      'whitespace in a family value',
      schema.replace('prune_orphan_placement_sessions', 'prune_orphan_placement_ sessions'),
    ],
    ['primary key removed', schema.replace('.primaryKey()', '.notNull()')],
    [
      'opaque column spread',
      schema.replace("  phase: text('phase'", "  ...unknownColumns,\n  phase: text('phase'"),
    ],
    ['commented declaration', `/* ${schema} */`],
    ['function-local declaration', `function unused() { ${schema.replace('export ', '')} }`],
  ])('requires the current schema %s', (_label, changed) => {
    expect(changed).not.toBe(schema);
    write('src/db/schema.ts', changed);
    expect(familyResult()?.status).not.toBe('init-only');
    expect(familyResult()?.initialization).toBeUndefined();
  });

  it('ignores other migrations and preserves unrelated primary-key stub detection', () => {
    write(
      'src/db/schema.ts',
      `${schema}\nexport const other = pgTable('other', {\n  family: text('family').primaryKey(),\n});`,
    );
    write('drizzle/0116_historical.sql', "INSERT INTO other (family) VALUES ('historical');");
    rmSync(join(root, migrationPath));
    write('drizzle/0118_unregistered.sql', migration);
    const report = audit(root);
    for (const table of ['other', 'session_orphan_control']) {
      expect(report.results).toContainEqual(
        expect.objectContaining({ table, field: 'family', insert_files: 0, status: 'stub' }),
      );
    }
  });

  it('keeps historical SQL outside retention while still rejecting forbidden runtime writes', () => {
    const retained = currentSchema.slice(
      currentSchema.indexOf('export const copilot_evidence_checkpoint ='),
      currentSchema.indexOf('export const copilot_evidence_checkpoint =') +
        currentSchema
          .slice(currentSchema.indexOf('export const copilot_evidence_checkpoint ='))
          .indexOf('\nexport const ', 1),
    );
    expect(retained).toMatch(/pgTable\(\s*'copilot_evidence_checkpoint'/);
    write('src/db/schema.ts', `${schema}\n${retained}`);
    write(
      'drizzle/0000_historical.sql',
      "INSERT INTO copilot_evidence_checkpoint (id) VALUES ('historical');",
    );
    expect(audit(root).historicalRetention.issues).toEqual([]);
    write(
      'src/forbidden-writer.ts',
      "await db.insert(copilot_evidence_checkpoint).values({ id: 'new' });",
    );
    expect(audit(root).historicalRetention.issues).toEqual([
      expect.objectContaining({
        code: 'production_write',
        kind: 'insert',
        path: 'src/forbidden-writer.ts',
      }),
    ]);
    expect(familyResult()).toMatchObject({ status: 'init-only', insert_files: 0 });
  });

  it('continues to count unrelated runtime writers and literal family writers normally', () => {
    write(
      'src/writer.ts',
      `
      await db.update(session_orphan_control).set({ phase: 'draining-pg-boss' });
      await db.insert(session_orphan_control).values({ family: 'prune_orphan_conversation_sessions', phase: 'pg-boss' });
    `,
    );
    const report = audit(root);
    expect(report.results).toContainEqual(
      expect.objectContaining({ field: 'phase', insert_files: 1, update_files: 1, status: 'live' }),
    );
    expect(familyResult()).toMatchObject({ insert_files: 1, update_files: 0, status: 'init-only' });
  });
});
