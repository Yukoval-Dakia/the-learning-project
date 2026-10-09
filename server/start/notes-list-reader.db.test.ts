import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/capabilities/notes/api/notes-list';
import {
  type NoteListQuery,
  NoteListQuerySchema,
  NoteListResponseSchema,
  loadNoteList,
} from '@/capabilities/notes/public';
import type { Db, Tx } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../tests/helpers/db';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartNoteList } from './notes-list-read';

// PREPARED ONLY. Parent executes under its DB/runtime authorization.
// In-process HTTP/Start parity does not establish built RPC or browser acceptance.
const scope = vi.hoisted((): { database?: Db | Tx } => ({}));
vi.mock('@/db/client', async () => {
  const { testDb } = await import('../../tests/helpers/db');
  return {
    get db() {
      return scope.database ?? testDb();
    },
  };
});
const now = new Date('2026-10-09T12:34:56.789Z');
const longText = '条件未决 α🙂 <script>原文</script> %_ \\ 深层正文\n'.repeat(200);
function note(
  id: string,
  overrides: Partial<typeof artifact.$inferInsert> = {},
): typeof artifact.$inferInsert {
  return {
    id,
    type: 'note_atomic',
    title: `笔记 ${id}`,
    knowledge_ids: [],
    intent_source: 'user',
    source: 'manual',
    generation_status: 'ready',
    verification_status: 'not_required',
    version: 17,
    created_at: now,
    updated_at: now,
    body_blocks: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }],
    },
    ...overrides,
  };
}
async function fixture(database: Db | Tx) {
  await database.insert(knowledge).values(
    [
      { id: 'seed:yuwen:root', domain: 'yuwen' },
      { id: 'language-parent', domain: 'wenyan' },
      { id: 'language-child', domain: null, parent_id: 'language-parent' },
      { id: 'custom-parent', domain: 'custom-science' },
      { id: 'custom-child', domain: null, parent_id: 'custom-parent' },
      { id: 'archived-parent', domain: 'wenyan', archived_at: now },
      { id: 'cutoff-child', domain: null, parent_id: 'archived-parent' },
      { id: 'archived-node', domain: 'wenyan', archived_at: now },
      { id: 'math-node', domain: 'math' },
    ].map((row) => ({ name: `真实知识 ${row.id}`, created_at: now, updated_at: now, ...row })),
  );
  await database.insert(artifact).values([
    note('language', {
      type: 'note_long',
      knowledge_ids: ['language-child', 'missing-label'],
      title: 'Title needle %_ α🙂',
      updated_at: new Date(now.getTime() + 3),
    }),
    note('custom', {
      type: 'note_hub',
      knowledge_ids: ['custom-child'],
      title: 'Custom needle',
      updated_at: new Date(now.getTime() + 2),
    }),
    note('math', {
      knowledge_ids: ['math-node'],
      body_blocks: null,
      title: 'Title needle only',
      updated_at: new Date(now.getTime() + 1),
    }),
    note('archived-label', { knowledge_ids: ['archived-node'] }),
    note('cutoff', { knowledge_ids: ['cutoff-child'] }),
    note('seed-only', { knowledge_ids: ['seed:yuwen:root'] }),
    note('unlabeled', { body_blocks: null, title: 'Unlabeled aXb decoy' }),
    note('archived-note', { archived_at: now, knowledge_ids: ['language-child'] }),
    note('interactive', { type: 'interactive', knowledge_ids: ['language-child'] }),
    note('quiz', { type: 'tool_quiz', knowledge_ids: ['language-child'] }),
  ]);
}
async function snapshot(database: Db | Tx) {
  const tables = await database.execute<{ table_name: string }>(sql`
    select tablename as table_name from pg_tables where schemaname = 'public' order by tablename
  `);
  const result: Record<string, { count: string; digest: string }> = {};
  for (const { table_name } of tables) {
    const rows = await database.execute<{ count: string; digest: string }>(sql`
      select count(*)::text as count,
      md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest
      from ${sql.identifier(table_name)} t
    `);
    result[table_name] = rows[0];
  }
  return result;
}
async function start(database: Db | Tx, input: NoteListQuery) {
  const result = await runAuthenticatedStartNoteList(
    { api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }) },
    new Request('http://isolated.test/_serverFn/notes', {
      headers: { 'x-internal-token': 'db-notes-token' },
    }),
    input,
    { database },
  );
  expect(NoteListResponseSchema.parse(result)).toEqual(result);
  expect(result).toEqual(await loadNoteList(database, NoteListQuerySchema.parse(input)));
  return result;
}
async function parity(database: Db | Tx, input: NoteListQuery) {
  scope.database = database;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, value);
  const response = await GET(new Request(`http://isolated.test/api/notes?${params}`));
  const result = await start(database, input);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(JSON.stringify(result));
  return result;
}
beforeEach(async () => {
  vi.stubEnv('INTERNAL_TOKEN', 'db-notes-token');
  scope.database = undefined;
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  scope.database = undefined;
});

describe('prepared native notes list real database parity', () => {
  it('reads nonzero uncommitted notes and subject ancestry through Tx, independent observer sees none, all tables unchanged', async () => {
    const observer = testDb(); // No helper rollback scope: transaction reserves a different pool connection.
    const initial = await snapshot(observer);
    const rollback = new Error('intentional rollback');
    await expect(
      observer.transaction(async (tx) => {
        await fixture(tx);
        const before = await snapshot(tx);
        expect(before.artifact.count).toBe('10');
        expect(before.knowledge.count).toBe('9');
        expect(await start(observer, {})).toEqual({ rows: [] });
        expect(await start(observer, { subject: 'wenyan' })).toEqual({ rows: [] });
        expect(await observer.select().from(knowledge)).toEqual([]);
        expect(await snapshot(observer)).toEqual(initial);
        const language = await parity(tx, { subject: 'wenyan' });
        expect(language.rows).toHaveLength(1);
        expect(language.rows[0]).toEqual({
          id: 'language',
          type: 'note_long',
          title: 'Title needle %_ α🙂',
          knowledge_ids: ['language-child', 'missing-label'],
          generation_status: 'ready',
          verification_status: 'not_required',
          version: 17,
          updated_at: new Date(now.getTime() + 3).toISOString(),
        });
        expect(await parity(tx, { subject: 'yuwen' })).toEqual(language);
        expect(await parity(tx, { subject: 'classical_chinese' })).toEqual(language);
        expect(await parity(tx, { subject: '  wenyan  ', query: '  NEEDLE  ' })).toEqual(language);
        expect(await parity(tx, { subject: `unknown'"%_\\ α🙂` })).toEqual({ rows: [] });
        expect((await parity(tx, { subject: 'custom-science' })).rows.map((row) => row.id)).toEqual(
          ['custom'],
        );
        expect(await parity(tx, { subject: 'unknown-empty' })).toEqual({ rows: [] });
        const all = await parity(tx, {});
        expect(all.rows).toHaveLength(7);
        expect(all.rows.slice(0, 3).map((row) => row.id)).toEqual(['language', 'custom', 'math']);
        expect(new Set(all.rows.map((row) => row.type))).toEqual(
          new Set(['note_atomic', 'note_hub', 'note_long']),
        );
        expect(all.rows.map((row) => row.id)).toEqual(
          expect.arrayContaining(['archived-label', 'cutoff', 'seed-only', 'unlabeled']),
        );
        expect(await snapshot(tx)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    scope.database = undefined;
    expect(await snapshot(observer)).toEqual(initial);
    expect(await start(observer, {})).toEqual({ rows: [] });
  });
  it('combines subject with literal title/body substring search and escaped percent/underscore, writes no tables', async () => {
    const database = testDb();
    await fixture(database);
    await database
      .insert(artifact)
      .values([
        note('underscore', { title: 'literal a_b', body_blocks: null }),
        note('percent', { title: 'literal 75% complete', body_blocks: null }),
        note('wildcard-decoy', { title: 'literal aXb 75X complete', body_blocks: null }),
      ]);
    const before = await snapshot(database);
    expect((await parity(database, { query: 'a_b' })).rows.map((row) => row.id)).toEqual([
      'underscore',
    ]);
    expect((await parity(database, { query: '75%' })).rows.map((row) => row.id)).toEqual([
      'percent',
    ]);
    expect((await parity(database, { subject: 'wenyan', query: 'deep missing' })).rows).toEqual([]);
    expect(
      (await parity(database, { subject: 'wenyan', query: '深层正文' })).rows.map((row) => row.id),
    ).toEqual(['language']);
    expect((await parity(database, { query: 'NEEDLE' })).rows.map((row) => row.id)).toEqual([
      'language',
      'custom',
      'math',
    ]);
    expect(
      (await parity(database, { subject: 'custom-science', query: 'needle' })).rows.map(
        (row) => row.id,
      ),
    ).toEqual(['custom']);
    expect(
      (await parity(database, { query: '<script>原文</script>' })).rows.length,
    ).toBeGreaterThan(0);
    expect(await snapshot(database)).toEqual(before);
  });
  it('retains200-character boundary, exact validation bodies and unlimited list, including rich nested body search', async () => {
    const database = testDb();
    const query = '边'.repeat(200);
    await database.insert(artifact).values(
      Array.from({ length: 205 }, (_, index) =>
        note(`bulk-${index}`, {
          title: `${index}:${query}`,
          updated_at: new Date(now.getTime() + index),
        }),
      ),
    );
    const before = await snapshot(database);
    expect((await parity(database, { query })).rows).toHaveLength(205);
    expect((await parity(database, {})).rows[0].id).toBe('bulk-204');
    for (const input of [
      { subject: '' },
      { subject: ' ' },
      { query: '' },
      { query: ' \n ' },
      { query: `${query}边` },
    ]) {
      const result: unknown = await start(database, input).catch((error: unknown) => error);
      if (!(result instanceof Response)) throw new Error('Expected Response');
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: 'validation_error' });
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input))
        if (value !== undefined) params.set(key, value);
      const response = await GET(new Request(`http://isolated.test/api/notes?${params}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'validation_error' });
    }
    expect(await snapshot(database)).toEqual(before);
  });
});
