import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminConfigWriter } from '@/capabilities/observability/public';
import { replaceConfigSnapshot } from '@/core/config/store';
import * as schema from '@/db/schema';
import { createAdminConfigWriter } from '@/server/config/admin-config-write';
import * as hydration from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { seedTraitId } from '@/subjects/builtin-trait-seeds';
import { SubjectRegistry } from '@/subjects/profile';
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
    expect(reset.committed_epoch).toBeGreaterThan(receipt.committed_epoch);
    const [storedEpoch] = await observer
      .select()
      .from(schema.system_config_epoch)
      .where(eq(schema.system_config_epoch.id, 'global'));
    expect(storedEpoch?.epoch).toBe(reset.committed_epoch);
    expect(reset.changes).toHaveLength(1);
    expect(reset.changes[0].epoch).toBe(reset.committed_epoch);
    const journals = await observer
      .select()
      .from(schema.system_config_journal)
      .where(eq(schema.system_config_journal.key, 'locale.learner'))
      .orderBy(schema.system_config_journal.revision);
    expect(journals.map(({ action }) => action)).toEqual(['set', 'clear']);
    expect(journals[1].revision).toBe(reset.changes[0].revision);
    expect(writer).toHaveBeenCalledTimes(3);
    expect(
      (await run((c) => c.getConfig())).keys.find((k) => k.key === 'locale.learner')?.value,
    ).toBe('zh-CN');
  });
});
