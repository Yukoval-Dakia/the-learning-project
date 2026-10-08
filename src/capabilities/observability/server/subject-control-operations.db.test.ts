import { and, eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db as httpDb } from '@/db/client';
import * as schema from '@/db/schema';
import {
  subject,
  subject_control_journal,
  subject_trait,
  subject_trait_binding,
} from '@/db/schema';
import { subjectRootId } from '@/server/subjects/ensure-subject-root';
import * as hydration from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { BUILTIN_TRAIT_SEEDS, seedTraitId } from '@/subjects/builtin-trait-seeds';
import { SubjectRegistry } from '@/subjects/profile';
import { CharterTraitSchema, SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { PATCH, RESET, RESTORE, RETIRE, VALIDATE } from '../api/admin-subject-control';
import {
  ValidateAdminSubjectInputSchema,
  renameAdminSubject,
  resetAdminSubject,
  restoreAdminSubject,
  retireAdminSubject,
  validateAdminSubject,
} from '../public';

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

async function forkCharter(id: string) {
  const now = new Date();
  const traitId = `trt_yuk1390_${id}`;
  const payload = CharterTraitSchema.parse({
    ...CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload),
    methodology: '观察证据与推断必须分开。\n'.repeat(300),
    noteTemplate: {
      ...CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload).noteTemplate,
      pitfall: '零值、空串、未知证据与相互冲突的条件。\n'.repeat(200),
    },
  });
  await poolDb.insert(subject_trait).values({
    id: traitId,
    trait_kind: 'charter',
    origin: 'custom',
    owner_subject_id: id,
    payload,
    payload_schema_version: 1,
    seed_version: null,
    revision: 0,
    created_at: now,
    updated_at: now,
  });
  await poolDb.insert(schema.subject_trait_journal).values({
    trait_id: traitId,
    revision: 0,
    payload,
    payload_schema_version: 1,
    seed_version: null,
    action: 'create',
    actor: 'migrate',
    created_at: now,
  });
  await poolDb
    .update(subject_trait_binding)
    .set({ trait_id: traitId })
    .where(
      and(
        eq(subject_trait_binding.subject_id, id),
        eq(subject_trait_binding.trait_kind, 'charter'),
      ),
    );
  await hydration.hydrateSubjectRegistryFromDb(poolDb);
  return { traitId, payload };
}

describe.each(['domain', 'HTTP'])('%s committed control operations', (transport) => {
  it('rolls back a rejected root mutation and does not retry or hydrate', async () => {
    const id = await createCustom();
    const rootId = subjectRootId(id);
    await poolDb
      .delete(schema.materialized_id_index)
      .where(eq(schema.materialized_id_index.materialized_id, rootId));
    await poolDb.delete(schema.event).where(eq(schema.event.subject_id, rootId));
    const before = await durableSnapshot();
    const lastGood = registry.get(id);
    const writerDb = transport === 'domain' ? poolDb : httpDb;
    const transaction = vi.spyOn(writerDb, 'transaction');
    const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
    if (transport === 'domain') {
      await expect(
        renameAdminSubject(poolDb, { subjectId: id, expectedRevision: 0, displayName: '新名' }),
      ).rejects.toThrow(/history/);
    } else {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await PATCH(request({ expectedRevision: 0, displayName: '新名' }), { id });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
    }
    expect(await durableSnapshot()).toEqual(before);
    expect(registry.get(id)).toBe(lastGood);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('rename commits once and updates the registry before returning', async () => {
    const id = await createCustom();
    const before = await controlState(id);
    const hydrate = observeCommittedHydration(id, [1]);
    const displayName = '  有机化学\n条件与证据  ';
    if (transport === 'domain') {
      expect(
        await renameAdminSubject(poolDb, { subjectId: id, expectedRevision: 0, displayName }),
      ).toEqual({ kind: 'ok', subjectRevision: 1 });
    } else {
      const response = await PATCH(request({ expectedRevision: 0, displayName, ignored: true }), {
        id,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subjectRevision: 1 });
    }
    const after = await controlState(id);
    expect(after.row).toMatchObject({ display_name: displayName.trim(), revision: 1 });
    expect(after.journal.slice(before.journal.length)).toMatchObject([
      {
        action: 'rename',
        revision: 1,
        detail: { from: before.row?.display_name, to: displayName.trim() },
      },
    ]);
    expect(after.journal).toHaveLength(before.journal.length + 1);
    expect(registry.get(id)?.displayName).toBe(displayName.trim());
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(transport === 'domain' ? poolDb : httpDb);
    // The observer is a second physical connection, not the writer's Tx handle.
    const writerPid = await poolDb.execute(sql`select pg_backend_pid() as pid`);
    const observerPid = await observerDb.execute(sql`select pg_backend_pid() as pid`);
    expect(observerPid[0]?.pid).not.toBe(writerPid[0]?.pid);
  });

  it('retire and restore each commit once and update selectable/resolvable sets', async () => {
    const id = await createCustom();
    const before = await controlState(id);
    const hydrate = observeCommittedHydration(id, [1, 2]);
    if (transport === 'domain') {
      expect(await retireAdminSubject(poolDb, { subjectId: id, expectedRevision: 0 })).toEqual({
        kind: 'ok',
        subjectRevision: 1,
      });
    } else {
      const response = await RETIRE(request({ expectedRevision: 0 }), { id });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subjectRevision: 1 });
    }
    expect(registry.listIds('selectable')).not.toContain(id);
    expect(registry.listIds('resolvable')).toContain(id);
    const retired = await controlState(id);
    expect(retired.row).toMatchObject({ revision: 1, retired_at: expect.any(Date) });
    expect(retired.journal.slice(before.journal.length)).toMatchObject([
      { action: 'retire', revision: 1 },
    ]);
    expect(retired.journal).toHaveLength(before.journal.length + 1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    if (transport === 'domain') {
      expect(await restoreAdminSubject(poolDb, { subjectId: id, expectedRevision: 1 })).toEqual({
        kind: 'ok',
        subjectRevision: 2,
      });
    } else {
      const response = await RESTORE(request({ expectedRevision: 1 }), { id });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subjectRevision: 2 });
    }
    expect(registry.listIds('selectable')).toContain(id);
    const restored = await controlState(id);
    expect(restored.row).toMatchObject({ revision: 2, retired_at: null });
    expect(restored.journal.slice(retired.journal.length)).toMatchObject([
      { action: 'restore', revision: 2 },
    ]);
    expect(restored.journal).toHaveLength(retired.journal.length + 1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenNthCalledWith(2, transport === 'domain' ? poolDb : httpDb);
  });

  it('reset performs a real commit, hydrates seed bindings and preserves the orphan payload', async () => {
    const id = await createCustom();
    const fork = await forkCharter(id);
    expect(registry.get(id)?.promptFragments.methodology).toBe(fork.payload.methodology);
    const before = await controlState(id);
    const traitsBefore = await observerDb.select().from(subject_trait).orderBy(subject_trait.id);
    const traitJournalBefore = await observerDb
      .select()
      .from(schema.subject_trait_journal)
      .orderBy(schema.subject_trait_journal.change_seq);
    const hydrate = observeCommittedHydration(id, [1]);
    if (transport === 'domain') {
      expect(await resetAdminSubject(poolDb, { subjectId: id, expectedRevision: 0 })).toEqual({
        kind: 'ok',
        subjectRevision: 1,
      });
    } else {
      const response = await RESET(request({ expectedRevision: 0 }), { id });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ subjectRevision: 1 });
    }
    const after = await controlState(id);
    expect(after.row?.revision).toBe(1);
    expect(after.bindings).toHaveLength(SUBJECT_TRAIT_KINDS.length);
    for (const binding of after.bindings)
      expect(binding.trait_id).toBe(seedTraitId('general', binding.trait_kind));
    expect(after.journal).toHaveLength(before.journal.length + 1);
    expect(after.journal.at(-1)).toMatchObject({
      action: 'reset',
      revision: 1,
      detail: {
        rebound: [
          {
            kind: 'charter',
            from_trait_id: fork.traitId,
            to_trait_id: seedTraitId('general', 'charter'),
          },
        ],
      },
    });
    expect(await observerDb.select().from(subject_trait).orderBy(subject_trait.id)).toEqual(
      traitsBefore,
    );
    expect(
      await observerDb
        .select()
        .from(schema.subject_trait_journal)
        .orderBy(schema.subject_trait_journal.change_seq),
    ).toEqual(traitJournalBefore);
    expect(registry.get(id)?.promptFragments.methodology).toBe(
      CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload).methodology,
    );
    expect(hydration.isGeneralFallbackFor(id)).toBe(true);
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(transport === 'domain' ? poolDb : httpDb);
  });

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

it('rejections and noops leave durable state unchanged and never hydrate', async () => {
  const id = await createCustom();
  const before = await durableSnapshot();
  const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
  const cases: {
    operation: () => Promise<unknown>;
    handler: typeof PATCH;
    body: unknown;
    id: string;
    kind: string;
    status: number;
  }[] = [
    {
      operation: () =>
        renameAdminSubject(poolDb, {
          subjectId: id,
          expectedRevision: 0,
          displayName: '化学：边界与歧义',
        }),
      handler: PATCH,
      body: { expectedRevision: 0, displayName: '化学：边界与歧义' },
      id,
      kind: 'noop',
      status: 200,
    },
    {
      operation: () => restoreAdminSubject(poolDb, { subjectId: id, expectedRevision: 0 }),
      handler: RESTORE,
      body: { expectedRevision: 0 },
      id,
      kind: 'noop',
      status: 200,
    },
    {
      operation: () => resetAdminSubject(poolDb, { subjectId: id, expectedRevision: 0 }),
      handler: RESET,
      body: { expectedRevision: 0 },
      id,
      kind: 'noop',
      status: 200,
    },
    {
      operation: () => retireAdminSubject(poolDb, { subjectId: id, expectedRevision: 99 }),
      handler: RETIRE,
      body: { expectedRevision: 99 },
      id,
      kind: 'stale',
      status: 409,
    },
    {
      operation: () =>
        renameAdminSubject(poolDb, { subjectId: id, expectedRevision: 0, displayName: '语文' }),
      handler: PATCH,
      body: { expectedRevision: 0, displayName: '语文' },
      id,
      kind: 'conflict',
      status: 409,
    },
    {
      operation: () =>
        renameAdminSubject(poolDb, { subjectId: id, expectedRevision: 0, displayName: ' \n\t ' }),
      handler: PATCH,
      body: { expectedRevision: 0, displayName: ' \n\t ' },
      id,
      kind: 'invalid',
      status: 422,
    },
    {
      operation: () => retireAdminSubject(poolDb, { subjectId: 'general', expectedRevision: 0 }),
      handler: RETIRE,
      body: { expectedRevision: 0 },
      id: 'general',
      kind: 'forbidden',
      status: 422,
    },
    {
      operation: () => resetAdminSubject(poolDb, { subjectId: 'general', expectedRevision: 0 }),
      handler: RESET,
      body: { expectedRevision: 0 },
      id: 'general',
      kind: 'forbidden',
      status: 422,
    },
    {
      operation: () => retireAdminSubject(poolDb, { subjectId: 'absent', expectedRevision: 0 }),
      handler: RETIRE,
      body: { expectedRevision: 0 },
      id: 'absent',
      kind: 'not_found',
      status: 404,
    },
  ];
  for (const candidate of cases) {
    expect(await candidate.operation()).toMatchObject({ kind: candidate.kind });
    const response = await candidate.handler(request(candidate.body), { id: candidate.id });
    expect(response.status).toBe(candidate.status);
    const body = await response.json();
    if (candidate.kind === 'stale')
      expect(body).toEqual({
        error: 'stale_revision',
        message: 'stale subject revision',
        currentRevision: 0,
      });
    if (candidate.kind === 'conflict')
      expect(body).toEqual({ error: 'display name "语文" is already taken' });
    expect(await durableSnapshot()).toEqual(before);
    expect(hydrate).not.toHaveBeenCalled();
  }
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

it('validate preserves the entire domain/HTTP DTO, including profile, without any writes', async () => {
  const id = await createCustom();
  const before = await durableSnapshot();
  const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
  const transaction = vi.spyOn(poolDb, 'transaction');
  const httpTransaction = vi.spyOn(httpDb, 'transaction');
  const overrides = {
    charter: CharterTraitSchema.parse({
      ...CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload),
      methodology: '完整候选，仅预检。\n'.repeat(500),
    }),
    judge_policy: BUILTIN_TRAIT_SEEDS.general.judge_policy.payload,
    cause_taxonomy: BUILTIN_TRAIT_SEEDS.general.cause_taxonomy.payload,
    source_policy: BUILTIN_TRAIT_SEEDS.general.source_policy.payload,
    render_theme: BUILTIN_TRAIT_SEEDS.general.render_theme.payload,
    scheduling: BUILTIN_TRAIT_SEEDS.general.scheduling.payload,
  };
  for (const traitPayloadOverrides of [
    undefined,
    overrides,
    { charter: overrides.charter },
    { charter: { nested: [{ evidence: '歧义\n'.repeat(300) }, null], unknown: true } },
  ]) {
    const parsed = ValidateAdminSubjectInputSchema.parse({ traitPayloadOverrides });
    const result = await validateAdminSubject(poolDb, { subjectId: id, ...parsed });
    const response = await VALIDATE(request({ traitPayloadOverrides, ignored: true }), { id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(result)));
    if (traitPayloadOverrides === undefined || traitPayloadOverrides === overrides) {
      expect(result).toMatchObject({
        valid: true,
        profile: { id, displayName: '化学：边界与歧义', version: 'preflight' },
      });
    } else expect(result).toMatchObject({ valid: false, warnings: [] });
  }
  for (const body of [undefined, '', ' \n\t ']) {
    const response = await VALIDATE(new Request('http://localhost', { method: 'POST', body }), {
      id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(JSON.stringify(await validateAdminSubject(poolDb, { subjectId: id }))),
    );
  }
  const alien = await VALIDATE(request({ traitPayloadOverrides: { alien: {} } }), { id: 'absent' });
  expect(alien.status).toBe(400);
  expect(await alien.json()).toEqual({
    error: 'traitPayloadOverrides must be keyed by trait kind',
  });
  expect(await validateAdminSubject(poolDb, { subjectId: 'absent' })).toBeNull();
  const absent = await VALIDATE(request({}), { id: 'absent' });
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: 'unknown subject "absent"' });
  expect(await durableSnapshot()).toEqual(before);
  expect(hydrate).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(httpTransaction).not.toHaveBeenCalled();
});
