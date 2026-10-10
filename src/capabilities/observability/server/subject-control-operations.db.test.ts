import { eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db as httpDb } from '@/db/client';
import * as schema from '@/db/schema';
import { subject, subject_control_journal, subject_trait_binding } from '@/db/schema';
import * as hydration from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { SubjectRegistry } from '@/subjects/profile';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PATCH, RESTORE, RETIRE } from '../api/admin-subject-control';
import { renameAdminSubject, restoreAdminSubject, retireAdminSubject } from '../public';

const isolated = vi.hoisted(() => ({ getRegistry: vi.fn() }));
vi.mock('@/subjects/profile', async (original) => ({
  ...(await original<typeof import('@/subjects/profile')>()),
  getDefaultSubjectRegistry: isolated.getRegistry,
}));

// These operations own real transactions. No outer transaction or savepoint shim.
const poolDb = testDb();
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const observerClient = postgres(url, { max: 1 });
const observerDb = drizzle(observerClient, { schema });
let registry: SubjectRegistry;

beforeEach(async () => {
  registry = new SubjectRegistry();
  isolated.getRegistry.mockReturnValue(registry);
  await resetDb();
  await reconcileBuiltinTraits(poolDb);
  await hydration.hydrateSubjectRegistryFromDb(poolDb);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => observerClient.end());

function request(body: unknown): Request {
  return new Request('http://localhost/api/admin/subjects/control', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function createCustom() {
  const result = await thinCreateSubject(poolDb, '化学：边界与歧义');
  if (result.kind !== 'created') throw new Error(`thin-create failed: ${result.kind}`);
  await hydration.hydrateSubjectRegistryFromDb(poolDb);
  return result.payload.id;
}

async function controlState(id: string) {
  const [row] = await observerDb.select().from(subject).where(eq(subject.id, id));
  const journal = await observerDb
    .select()
    .from(subject_control_journal)
    .where(eq(subject_control_journal.subject_id, id))
    .orderBy(subject_control_journal.revision);
  const bindings = await observerDb
    .select()
    .from(subject_trait_binding)
    .where(eq(subject_trait_binding.subject_id, id))
    .orderBy(subject_trait_binding.trait_kind);
  return { row, journal, bindings };
}

async function durableSnapshot() {
  const tables = [
    schema.subject,
    schema.subject_trait,
    schema.subject_trait_binding,
    schema.subject_trait_journal,
    schema.subject_control_journal,
    schema.subject_name_claim,
    schema.knowledge,
    schema.event,
    schema.materialized_id_index,
  ];
  // Server-side ordering also covers nested JSON and timestamps, without dropping fields.
  return Promise.all([
    ...tables.map((table) =>
      observerDb.execute(sql`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`),
    ),
    observerDb.execute(sql`select last_value, is_called from subject_change_seq`),
  ]);
}

function observeCommittedHydration(id: string, expectedRevisions: number[]) {
  const originalHydrate = hydration.hydrateSubjectRegistryFromDb;
  let index = 0;
  return vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb').mockImplementation(async (...args) => {
    const committed = await controlState(id);
    expect(committed.row?.revision).toBe(expectedRevisions[index]);
    expect(committed.journal.at(-1)?.revision).toBe(expectedRevisions[index]);
    index += 1;
    return originalHydrate(...args);
  });
}

describe.each(['domain', 'HTTP'])('%s committed control operations', (transport) => {
  it('a real post-commit hydrate query failure preserves last-good without retry or rollback', async () => {
    const id = await createCustom();
    const lastGood = registry.get(id);
    const before = await controlState(id);
    const writerDb = transport === 'domain' ? poolDb : httpDb;
    const transaction = vi.spyOn(writerDb, 'transaction');
    const hydrate = observeCommittedHydration(id, [1]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Only the top-level hydration select is redirected. Transaction selects remain real.
    // Postgres returns 42P01 for this absent relation, inside the real hydrate catch.
    const missingTable = pgTable('yuk1390_absent_hydrate_subject', { id: text('id') });
    const originalSelect = writerDb.select.bind(writerDb);
    const select = vi.spyOn(writerDb, 'select').mockImplementationOnce(
      (fields) =>
        new Proxy(originalSelect(fields), {
          get(target, key, receiver) {
            if (key === 'from') return () => target.from(missingTable);
            return Reflect.get(target, key, receiver);
          },
        }),
    );
    const displayName = '提交成功，水合查询失败';
    if (transport === 'domain') {
      expect(
        await renameAdminSubject(writerDb, { subjectId: id, expectedRevision: 0, displayName }),
      ).toEqual({ kind: 'ok', subjectRevision: 1 });
    } else {
      const response = await PATCH(request({ expectedRevision: 0, displayName }), { id });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subjectRevision: 1 });
    }
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(writerDb);
    expect(await hydrate.mock.results[0]?.value).toEqual({
      hydrated: [],
      builtinFloor: [],
      skipped: [],
      removed: [],
    });
    expect(select).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('hydration failed'),
      expect.objectContaining({
        cause: expect.objectContaining({ code: '42P01' }),
      }),
    );
    expect(registry.get(id)).toBe(lastGood);
    const after = await controlState(id);
    expect(after.row).toMatchObject({ display_name: displayName, revision: 1 });
    expect(after.journal).toHaveLength(before.journal.length + 1);
    expect(after.journal.at(-1)).toMatchObject({ action: 'rename', revision: 1 });
  });
});

it('retired noop and restore conflict are also read-only and do not hydrate', async () => {
  const id = await createCustom();
  await retireAdminSubject(poolDb, { subjectId: id, expectedRevision: 0 });
  const replacement = await thinCreateSubject(poolDb, '另一科目');
  expect(replacement.kind).toBe('created');
  if (replacement.kind !== 'created') throw new Error('replacement subject missing');
  // Reproduce the live-name collision without thin-create's retained canonical claim guard.
  await poolDb
    .update(subject)
    .set({ display_name: '化学：边界与歧义', display_name_norm: '化学：边界与歧义' })
    .where(eq(subject.id, replacement.payload.id));
  const before = await durableSnapshot();
  const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
  expect(await retireAdminSubject(poolDb, { subjectId: id, expectedRevision: 1 })).toEqual({
    kind: 'noop',
    subjectRevision: 1,
  });
  const noop = await RETIRE(request({ expectedRevision: 1 }), { id });
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual({ subjectRevision: 1, noop: true });
  expect(await restoreAdminSubject(poolDb, { subjectId: id, expectedRevision: 1 })).toEqual({
    kind: 'conflict',
    message: 'display name "化学：边界与歧义" is now taken by another live subject',
  });
  const conflict = await RESTORE(request({ expectedRevision: 1 }), { id });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    error: 'display name "化学：边界与歧义" is now taken by another live subject',
  });
  expect(await durableSnapshot()).toEqual(before);
  expect(hydrate).not.toHaveBeenCalled();
});
