import { eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as bindingsHttp } from '@/capabilities/observability/api/admin-subject-traits';
import { GET as subjectsHttp } from '@/capabilities/observability/api/admin-subjects';
import { GET as journalHttp } from '@/capabilities/observability/api/admin-trait-journal';
import { GET as catalogHttp } from '@/capabilities/observability/api/admin-traits';
import { setAdminConfigWriter } from '@/capabilities/observability/public';
import { replaceConfigSnapshot } from '@/core/config/store';
import * as schema from '@/db/schema';
import { createAdminConfigWriter } from '@/server/config/admin-config-write';
import * as hydration from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { BUILTIN_TRAIT_SEEDS, seedTraitId } from '@/subjects/builtin-trait-seeds';
import { SubjectRegistry } from '@/subjects/profile';
import { CharterTraitSchema } from '@/subjects/trait-schemas';
import { resetDb, testDb } from '../../tests/helpers/db';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartAdminControl } from './admin-control-read';
import { createStartAdminControlReader } from './admin-control-reader';

// Only connection and registry ownership are replaced. SQL, writers, public
// operations, hydration, HTTP adapters and the auth boundary remain real.
vi.mock('@/db/client', async () => {
  const { testDb } = await import('../../tests/helpers/db');
  return {
    get db() {
      return testDb();
    },
  };
});
const isolated = vi.hoisted(() => ({ registry: vi.fn() }));
vi.mock('@/subjects/profile', async (original) => ({
  ...(await original<typeof import('@/subjects/profile')>()),
  getDefaultSubjectRegistry: isolated.registry,
}));
const pool = testDb();
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const observerClient = postgres(url, { max: 1 });
const observer = drizzle(observerClient, { schema });
let registry: SubjectRegistry;
const seedId = seedTraitId('general', 'charter');
type Controls = Awaited<ReturnType<typeof createStartAdminControlReader>>;
const request = (token = 'isolated-controls-token') =>
  new Request('http://isolated.test/_serverFn/control', { headers: { 'x-internal-token': token } });
async function run<T>(operation: (controls: Controls) => Promise<T>) {
  const controls = await createStartAdminControlReader({ database: pool });
  return runAuthenticatedStartAdminControl(
    {
      api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }),
      adminControls: async () => controls,
    },
    request(),
    operation,
  );
}
async function denied(call: Promise<unknown>, status: number) {
  const error: unknown = await call.catch((e: unknown) => e);
  if (!(error instanceof Response)) throw new Error(`Expected Response: ${String(error)}`);
  expect(error.status).toBe(status);
  return error.json();
}
async function custom(name: string) {
  const created = await thinCreateSubject(pool, name);
  if (created.kind !== 'created') throw new Error(`Fixture creation failed: ${created.kind}`);
  await hydration.hydrateSubjectRegistryFromDb(pool);
  return created.payload.id;
}
async function trait(id: string) {
  const [row] = await observer
    .select()
    .from(schema.subject_trait)
    .where(eq(schema.subject_trait.id, id));
  if (!row) throw new Error(`Missing trait ${id}`);
  return row;
}
async function subject(id: string) {
  const [row] = await observer.select().from(schema.subject).where(eq(schema.subject.id, id));
  if (!row) throw new Error(`Missing subject ${id}`);
  return row;
}
const charter = (methodology: string) =>
  CharterTraitSchema.parse({
    ...CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload),
    methodology,
  });
async function snapshot() {
  // Exactly these twelve tables and the control-plane sequence, not all DB state.
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
    schema.system_config,
    schema.system_config_journal,
    schema.system_config_epoch,
  ];
  return Promise.all([
    ...tables.map((table) =>
      observer.execute(sql`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`),
    ),
    observer.execute(sql`select last_value, is_called from subject_change_seq`),
  ]);
}
beforeEach(async () => {
  vi.stubEnv('INTERNAL_TOKEN', 'isolated-controls-token');
  registry = new SubjectRegistry();
  isolated.registry.mockReturnValue(registry);
  await resetDb();
  await reconcileBuiltinTraits(pool);
  await hydration.hydrateSubjectRegistryFromDb(pool);
  replaceConfigSnapshot({ epoch: 0, entries: new Map(), hydratedAt: '' });
  setAdminConfigWriter(createAdminConfigWriter(pool));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const { __resetAdminConfigWriterForTests } = await import(
    '@/capabilities/observability/server/admin-config-writer'
  );
  __resetAdminConfigWriterForTests();
  replaceConfigSnapshot({ epoch: 0, entries: new Map(), hydratedAt: '' });
});
afterAll(() => observerClient.end());

describe('Start controls with committed pool writes and an independent observer', () => {
  it('reads the complete HTTP DTOs and bounded journal pages without writes', async () => {
    const id = await custom('保留长条件与歧义的科目');
    const before = await snapshot();
    const pairs = [
      [await run((c) => c.getSubjects()), await subjectsHttp()],
      [
        await run((c) => c.getSubjectTraits({ subjectId: id })),
        await bindingsHttp(request(), { id }),
      ],
      [
        await run((c) => c.getTraits({ kind: 'charter' })),
        await catalogHttp(new Request('http://isolated.test/api/admin/traits?kind=charter')),
      ],
      [
        await run((c) => c.getTraitJournal({ traitId: seedId, limit: '1' })),
        await journalHttp(new Request('http://isolated.test/api/admin/traits/x/journal?limit=1'), {
          id: seedId,
        }),
      ],
    ] satisfies Array<[unknown, Response]>;
    for (const [dto, response] of pairs) {
      expect(response.status).toBe(200);
      expect(dto).toEqual(await response.json());
    }
    expect(await snapshot()).toEqual(before);
  });
  it('gates auth/epoch before canonical resolution, and rejects general/CAS/missing payload without writes', async () => {
    const id = await custom('拒绝矩阵科目');
    const before = await snapshot();
    const resolver = vi.fn(() => createStartAdminControlReader({ database: pool }));
    await denied(
      runAuthenticatedStartAdminControl(
        {
          api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }),
          adminControls: resolver,
        },
        request('wrong'),
        (c) => c.retireSubject({ subjectId: id, expectedRevision: -1 }),
      ),
      401,
    );
    await denied(
      runAuthenticatedStartAdminControl(
        {
          api: buildHonoApp([], {
            epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
          }),
          adminControls: resolver,
        },
        request(),
        (c) => c.getSubjects(),
      ),
      503,
    );
    expect(resolver).not.toHaveBeenCalled();
    const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
    await denied(
      run((c) => c.retireSubject({ subjectId: 'general', expectedRevision: 0 })),
      422,
    );
    await denied(
      run((c) => c.resetSubject({ subjectId: 'general', expectedRevision: 0 })),
      422,
    );
    await denied(
      run((c) =>
        c.forkSubjectTrait({ subjectId: 'general', kind: 'charter', expectedSubjectRevision: 0 }),
      ),
      422,
    );
    await denied(
      run((c) =>
        c.rebindSubjectTrait({
          subjectId: 'general',
          kind: 'charter',
          expectedSubjectRevision: 0,
          targetTraitId: seedId,
        }),
      ),
      422,
    );
    expect(
      await denied(
        run((c) =>
          c.renameSubject({ subjectId: id, expectedRevision: 99, displayName: '不会写入' }),
        ),
        409,
      ),
    ).toMatchObject({ currentRevision: 0 });
    await denied(
      run((c) =>
        c.editSubjectTrait({
          subjectId: id,
          kind: 'charter',
          expectedSubjectRevision: 0,
          expectedTraitRevision: 0,
        }),
      ),
      422,
    );
    await denied(
      run((c) => c.editSharedTrait({ traitId: seedId, expectedRevision: 0 })),
      422,
    );
    expect(hydrate).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
  it('commits COW before exactly one hydrate, preserves other binders, and repeats as noop', async () => {
    const a = await custom('COW 科目');
    const b = await custom('共享来源科目');
    const seed = await trait(seedId);
    const payload = charter('证据、边界与失败分开。\n'.repeat(300));
    const oldProfile = registry.get(a);
    const original = hydration.hydrateSubjectRegistryFromDb;
    const hydrate = vi
      .spyOn(hydration, 'hydrateSubjectRegistryFromDb')
      .mockImplementation(async (db) => {
        expect((await subject(a)).revision).toBe(1);
        const [binding] = await observer
          .select()
          .from(schema.subject_trait_binding)
          .where(eq(schema.subject_trait_binding.subject_id, a))
          .orderBy(schema.subject_trait_binding.trait_kind);
        expect(binding).toBeDefined();
        expect(registry.get(a)).toBe(oldProfile);
        return original(db);
      });
    const result = await run((c) =>
      c.editSubjectTrait({
        subjectId: a,
        kind: 'charter',
        expectedSubjectRevision: 0,
        expectedTraitRevision: seed.revision,
        payload,
      }),
    );
    expect(result).toMatchObject({
      status: 201,
      forked: true,
      revision: 1,
      canonicalLocation: `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal`,
    });
    expect((await trait(result.traitId)).payload).toEqual(payload);
    expect(await trait(seedId)).toEqual(seed);
    expect(registry.get(a)?.promptFragments.methodology).toBe(payload.methodology);
    expect(registry.get(b)?.promptFragments.methodology).toBe(
      CharterTraitSchema.parse(seed.payload).methodology,
    );
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(pool);
    hydrate.mockRestore();
    const noopHydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
    const before = await snapshot();
    expect(
      await run((c) =>
        c.editSubjectTrait({
          subjectId: a,
          kind: 'charter',
          expectedSubjectRevision: 1,
          expectedTraitRevision: 1,
          payload,
        }),
      ),
    ).toMatchObject({ status: 200, noop: true });
    expect(await snapshot()).toEqual(before);
    expect(noopHydrate).not.toHaveBeenCalled();
  });
  it('forks, rebinds, and performs all five subject commands through the authenticated adapter', async () => {
    const id = await custom('控制行科目');
    const fork = await run((c) =>
      c.forkSubjectTrait({ subjectId: id, kind: 'charter', expectedSubjectRevision: 0 }),
    );
    expect(fork.status).toBe(201);
    expect(fork.canonicalLocation).toBe(
      `/api/admin/traits/${encodeURIComponent(fork.traitId)}/journal`,
    );
    expect(
      await run((c) =>
        c.renameSubject({ subjectId: id, expectedRevision: 1, displayName: '改名后科目' }),
      ),
    ).toEqual({ subjectRevision: 2 });
    expect(registry.get(id)?.displayName).toBe('改名后科目');
    expect(await run((c) => c.retireSubject({ subjectId: id, expectedRevision: 2 }))).toEqual({
      subjectRevision: 3,
    });
    expect((await subject(id)).retired_at).not.toBeNull();
    expect(await run((c) => c.restoreSubject({ subjectId: id, expectedRevision: 3 }))).toEqual({
      subjectRevision: 4,
    });
    expect((await subject(id)).retired_at).toBeNull();
    const beforeValidate = await snapshot();
    expect(await run((c) => c.validateSubject({ subjectId: id }))).toMatchObject({ valid: true });
    expect(await snapshot()).toEqual(beforeValidate);
    expect(await run((c) => c.resetSubject({ subjectId: id, expectedRevision: 4 }))).toEqual({
      subjectRevision: 5,
    });
    const rebound = await run((c) =>
      c.rebindSubjectTrait({
        subjectId: id,
        kind: 'charter',
        expectedSubjectRevision: 5,
        targetTraitId: fork.traitId,
      }),
    );
    expect(rebound.status).toBe(200);
    expect(rebound).not.toHaveProperty('canonicalLocation');
    expect((await subject(id)).revision).toBe(6);
  });
  it('fans out shared writes, rolls back forward, and resets seed lineage without extra hydration', async () => {
    const a = await custom('共享面一');
    const b = await custom('共享面二');
    const seed = await trait(seedId);
    const payload = charter('共享面保留来源与歧义。\n'.repeat(400));
    const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
    const edited = await run((c) =>
      c.editSharedTrait({ traitId: seedId, expectedRevision: seed.revision, payload }),
    );
    expect(edited).toMatchObject({ revision: seed.revision + 1, status: 200 });
    expect(edited).not.toHaveProperty('canonicalLocation');
    for (const id of [a, b, 'general'])
      expect(registry.get(id)?.promptFragments.methodology).toBe(payload.methodology);
    const rolled = await run((c) =>
      c.rollbackTrait({
        traitId: seedId,
        expectedRevision: edited.revision,
        targetRevision: seed.revision,
      }),
    );
    expect(rolled.revision).toBe(edited.revision + 1);
    expect((await trait(seedId)).payload).toEqual(seed.payload);
    const changed = await run((c) =>
      c.editSharedTrait({ traitId: seedId, expectedRevision: rolled.revision, payload }),
    );
    const reset = await run((c) =>
      c.resetTraitToSeed({ traitId: seedId, expectedRevision: changed.revision }),
    );
    expect(reset.revision).toBe(changed.revision + 1);
    expect(hydrate).toHaveBeenCalledTimes(4);
    const rows = await observer
      .select()
      .from(schema.subject_trait_journal)
      .where(eq(schema.subject_trait_journal.trait_id, seedId))
      .orderBy(schema.subject_trait_journal.revision);
    expect(rows).toHaveLength(5);
    expect(rows[2]).toMatchObject({ action: 'rollback', rolled_back_from: seed.revision });
    expect(rows[4].action).toBe('reset_to_seed');
  });
  it('retains a committed mutation and last-good registry when actual postcommit hydrate fails', async () => {
    const id = await custom('水合失败保留科目');
    const old = registry.get(id);
    const originalSelect = pool.select.bind(pool);
    const missing = pgTable('yuk1358_absent_hydrate_subject', { id: text('id') });
    const select = vi.spyOn(pool, 'select').mockImplementationOnce((fields) => {
      const builder = originalSelect(fields);
      return new Proxy(builder, {
        get(target, key, receiver) {
          if (key === 'from') return () => target.from(missing);
          return Reflect.get(target, key, receiver);
        },
      });
    });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transaction = vi.spyOn(pool, 'transaction');
    const result = await run((c) =>
      c.renameSubject({ subjectId: id, expectedRevision: 0, displayName: '已提交新名称' }),
    );
    expect(result).toEqual({ subjectRevision: 1 });
    expect((await subject(id)).display_name).toBe('已提交新名称');
    expect(registry.get(id)).toBe(old);
    expect(transaction).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cause: expect.objectContaining({ code: '42P01' }) }),
    );
  });
  it('uses the canonical config writer once per commit, retains receipts, and keeps secret config rejection atomic', async () => {
    const writer = vi.fn(createAdminConfigWriter(pool));
    setAdminConfigWriter(writer);
    const receipt = await run((c) =>
      c.patchConfig({
        changes: [{ action: 'set', key: 'locale.learner', value: 'en' }],
        note: '保留确认原因\n与条件',
      }),
    );
    expect(receipt.changes).toHaveLength(1);
    expect(writer).toHaveBeenCalledOnce();
    expect(
      (await run((c) => c.getConfig())).keys.find((k) => k.key === 'locale.learner')?.value,
    ).toBe('en');
    const before = await snapshot();
    await denied(
      run((c) =>
        c.patchConfig({
          changes: [
            { action: 'set', key: 'locale.learner', value: 'zh-CN' },
            { action: 'set', key: 'XIAOMI_API_KEY', value: 'forbidden-secret' },
          ],
        }),
      ),
      400,
    );
    expect(await snapshot()).toEqual(before);
    const reset = await run((c) => c.resetConfig({ keys: ['locale.learner'] }));
    expect(reset.committed_epoch).toBe(receipt.committed_epoch + 1);
    expect(writer).toHaveBeenCalledTimes(3);
    expect(
      (await run((c) => c.getConfig())).keys.find((k) => k.key === 'locale.learner')?.value,
    ).toBe('zh-CN');
  });
});
