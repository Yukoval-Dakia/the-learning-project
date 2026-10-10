import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db as httpDb } from '@/db/client';
import * as schema from '@/db/schema';
import * as hydration from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { thinCreateSubject } from '@/server/subjects/thin-create';
import { BUILTIN_TRAIT_SEEDS, seedTraitId } from '@/subjects/builtin-trait-seeds';
import { SubjectRegistry } from '@/subjects/profile';
import { CharterTraitSchema, JudgePolicyTraitSchema } from '@/subjects/trait-schemas';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { BINDING, FORK, PUT as SUBJECT_PUT } from '../api/admin-subject-trait-write';
import { RESET_TO_SEED, ROLLBACK, PUT as SHARED_PUT } from '../api/admin-trait-write';
import { TraitWriteResponseSchema } from '../api/trait-write-contracts';
import {
  type EditSharedTraitInput,
  type EditSubjectTraitInput,
  type ForkSubjectTraitInput,
  type RebindSubjectTraitInput,
  type ResetTraitToSeedInput,
  type RollbackTraitInput,
  type TraitWriteResult,
  editSharedTrait,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
  resetTraitToSeed,
  rollbackTrait,
} from '../public';

const isolated = vi.hoisted(() => ({ getRegistry: vi.fn() }));
vi.mock('@/subjects/profile', async (original) => ({
  ...(await original<typeof import('@/subjects/profile')>()),
  getDefaultSubjectRegistry: isolated.getRegistry,
}));

// Real pool transactions and a distinct physical observer. No outer Tx/savepoints.
const poolDb = testDb();
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const observerClient = postgres(url, { max: 1 });
const observerDb = drizzle(observerClient, { schema });
let registry: SubjectRegistry;
const seedId = seedTraitId('general', 'charter');

beforeEach(async () => {
  registry = new SubjectRegistry();
  isolated.getRegistry.mockReturnValue(registry);
  await resetDb();
  await reconcileBuiltinTraits(poolDb);
  await hydration.hydrateSubjectRegistryFromDb(poolDb);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => observerClient.end());

function request(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });
}
async function createCustom(name = '化学：条件、证据与未知') {
  const result = await thinCreateSubject(poolDb, name);
  if (result.kind !== 'created') throw new Error(`thin-create failed: ${result.kind}`);
  await hydration.hydrateSubjectRegistryFromDb(poolDb);
  return result.payload.id;
}
async function trait(id: string) {
  const [row] = await observerDb
    .select()
    .from(schema.subject_trait)
    .where(eq(schema.subject_trait.id, id));
  if (!row) throw new Error(`trait ${id} missing`);
  return row;
}
async function journal(id: string) {
  return observerDb
    .select()
    .from(schema.subject_trait_journal)
    .where(eq(schema.subject_trait_journal.trait_id, id))
    .orderBy(schema.subject_trait_journal.revision);
}
function charter(methodology: string) {
  const seed = CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload);
  return CharterTraitSchema.parse({
    ...seed,
    methodology,
    noteTemplate: {
      ...seed.noteTemplate,
      pitfall: '零值、空串、矛盾条件和未知证据。\n'.repeat(250),
    },
  });
}
async function durableSnapshot() {
  // Coverage is these nine tables and subject_change_seq, not the entire database.
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
  return Promise.all([
    ...tables.map((table) =>
      observerDb.execute(sql`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`),
    ),
    observerDb.execute(sql`select last_value, is_called from subject_change_seq`),
  ]);
}

type Command =
  | { kind: 'edit'; input: EditSubjectTraitInput }
  | { kind: 'fork'; input: ForkSubjectTraitInput }
  | { kind: 'rebind'; input: RebindSubjectTraitInput }
  | { kind: 'shared'; input: EditSharedTraitInput }
  | { kind: 'rollback'; input: RollbackTraitInput }
  | { kind: 'reset'; input: ResetTraitToSeedInput };
function domain(command: Command) {
  switch (command.kind) {
    case 'edit':
      return editSubjectTrait(poolDb, command.input);
    case 'fork':
      return forkSubjectTrait(poolDb, command.input);
    case 'rebind':
      return rebindSubjectTrait(poolDb, command.input);
    case 'shared':
      return editSharedTrait(poolDb, command.input);
    case 'rollback':
      return rollbackTrait(poolDb, command.input);
    case 'reset':
      return resetTraitToSeed(poolDb, command.input);
  }
}
function http(command: Command) {
  switch (command.kind) {
    case 'edit':
      return SUBJECT_PUT(request({ ...command.input, ignored: true }), {
        id: command.input.subjectId,
        kind: command.input.kind,
      });
    case 'fork':
      return FORK(request({ ...command.input, ignored: true }), {
        id: command.input.subjectId,
        kind: command.input.kind,
      });
    case 'rebind':
      return BINDING(request({ ...command.input, ignored: true }), {
        id: command.input.subjectId,
        kind: command.input.kind,
      });
    case 'shared':
      return SHARED_PUT(request({ ...command.input, ignored: true }), {
        id: command.input.traitId,
      });
    case 'rollback':
      return ROLLBACK(request({ ...command.input, ignored: true }), { id: command.input.traitId });
    case 'reset':
      return RESET_TO_SEED(request({ ...command.input, ignored: true }), {
        id: command.input.traitId,
      });
  }
}
async function run(transport: 'domain' | 'HTTP', command: Command): Promise<TraitWriteResult> {
  if (transport === 'domain') return domain(command);
  const response = await http(command);
  const body = TraitWriteResponseSchema.parse(await response.json());
  const result: TraitWriteResult =
    'noop' in body
      ? { kind: 'noop', traitId: body.traitId, revision: body.revision }
      : { kind: 'ok', ...body };
  const canonical = command.kind === 'edit' || command.kind === 'fork';
  expect(response.status).toBe(canonical && result.kind === 'ok' && result.forked ? 201 : 200);
  expect(response.headers.get('Location')).toBe(
    canonical ? `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal` : null,
  );
  return result;
}
function observeCommit(check: () => Promise<void>) {
  const original = hydration.hydrateSubjectRegistryFromDb;
  return vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb').mockImplementation(async (...args) => {
    await check();
    return original(...args);
  });
}
function requireOk(result: TraitWriteResult) {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error(`expected ok, received ${JSON.stringify(result)}`);
  return result;
}

// Success paths run independently through both consumers on fresh fixtures.
describe.each(['domain', 'HTTP'] as const)('%s real committed trait operations', (transport) => {
  it('rollback appends forward, keeps old journal and lineage, and restores all registry binders', async () => {
    const id = await createCustom();
    const seed = await trait(seedId);
    const originalJournal = await journal(seedId);
    const target = originalJournal.find((row) => row.revision === seed.revision);
    if (!target) throw new Error('seed snapshot missing');
    await editSharedTrait(poolDb, {
      traitId: seedId,
      expectedRevision: seed.revision,
      payload: charter('新的共享内容。\n'.repeat(400)),
    });
    const edited = await trait(seedId);
    const beforeJournal = await journal(seedId);
    const hydrate = observeCommit(async () => {
      expect((await trait(seedId)).revision).toBe(edited.revision + 1);
    });
    expect(
      await run(transport, {
        kind: 'rollback',
        input: {
          traitId: seedId,
          expectedRevision: edited.revision,
          targetRevision: target.revision,
        },
      }),
    ).toEqual({ kind: 'ok', traitId: seedId, revision: edited.revision + 1, forked: false });
    const after = await trait(seedId);
    expect(after).toMatchObject({
      payload: target.payload,
      payload_schema_version: target.payload_schema_version,
      seed_version: seed.seed_version,
      owner_subject_id: seed.owner_subject_id,
      origin: seed.origin,
    });
    const afterJournal = await journal(seedId);
    expect(afterJournal.slice(0, beforeJournal.length)).toEqual(beforeJournal);
    expect(afterJournal).toHaveLength(beforeJournal.length + 1);
    expect(afterJournal.at(-1)).toMatchObject({
      action: 'rollback',
      revision: edited.revision + 1,
      rolled_back_from: target.revision,
      seed_version: seed.seed_version,
      payload: target.payload,
    });
    for (const binder of ['general', id])
      expect(registry.get(binder)?.promptFragments.methodology).toBe(
        CharterTraitSchema.parse(target.payload).methodology,
      );
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(transport === 'domain' ? poolDb : httpDb);
  });
});

async function assertReadOnlyParity(command: Command, expected: Partial<TraitWriteResult>) {
  const before = await durableSnapshot();
  const lastGood = registry.listIds('resolvable').map((id) => registry.get(id));
  const hydrate = vi.spyOn(hydration, 'hydrateSubjectRegistryFromDb');
  const result = await domain(command);
  expect(result).toMatchObject(expected);
  const response = await http(command);
  const body = await response.json();
  switch (result.kind) {
    case 'ok':
      throw new Error('read-only operation unexpectedly committed');
    case 'noop':
      expect(response.status).toBe(200);
      expect(body).toEqual({ traitId: result.traitId, revision: result.revision, noop: true });
      expect(response.headers.get('Location')).toBe(
        command.kind === 'edit' || command.kind === 'fork'
          ? `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal`
          : null,
      );
      break;
    case 'stale':
      expect(response.status).toBe(409);
      expect(body).toEqual({
        error: 'stale_revision',
        message: `stale ${result.axis} revision`,
        currentRevision: result.currentRevision,
      });
      break;
    case 'invalid':
      expect(response.status).toBe(422);
      expect(body).toEqual({
        error: result.message,
        ...(result.issues ? { issues: result.issues } : {}),
      });
      break;
    case 'forbidden':
      expect(response.status).toBe(422);
      expect(body).toEqual({ error: result.message });
      break;
    case 'not_found':
      expect(response.status).toBe(404);
      expect(body).toEqual({ error: result.message });
      break;
  }
  if (result.kind !== 'noop') expect(response.headers.get('Location')).toBeNull();
  expect(await durableSnapshot()).toEqual(before);
  expect(registry.listIds('resolvable').map((id) => registry.get(id))).toEqual(lastGood);
  expect(hydrate).not.toHaveBeenCalled();
  hydrate.mockRestore();
  return result;
}

it('preserves both CAS axes, validation/lookup order, general restrictions and all unchanged-content noops', async () => {
  const id = await createCustom();
  const seed = await trait(seedId);
  const input: EditSubjectTraitInput = {
    subjectId: id,
    kind: 'charter',
    expectedSubjectRevision: 0,
    expectedTraitRevision: seed.revision,
    payload: charter('合法候选。\n'.repeat(300)),
  };
  await assertReadOnlyParity(
    { kind: 'edit', input: { ...input, expectedSubjectRevision: 99, expectedTraitRevision: 99 } },
    { kind: 'stale', axis: 'subject', currentRevision: 0 },
  );
  await assertReadOnlyParity(
    { kind: 'edit', input: { ...input, expectedTraitRevision: 99 } },
    { kind: 'stale', axis: 'trait', currentRevision: seed.revision },
  );
  await assertReadOnlyParity(
    { kind: 'edit', input: { ...input, subjectId: 'absent', payload: undefined } },
    { kind: 'invalid' },
  );
  await assertReadOnlyParity(
    { kind: 'edit', input: { ...input, subjectId: 'absent' } },
    { kind: 'not_found' },
  );
  await assertReadOnlyParity(
    { kind: 'shared', input: { traitId: 'absent', expectedRevision: 99 } },
    { kind: 'not_found', message: 'unknown trait "absent"' },
  );
  await assertReadOnlyParity(
    { kind: 'shared', input: { traitId: seedId, expectedRevision: 99 } },
    { kind: 'invalid' },
  );
  await assertReadOnlyParity(
    { kind: 'shared', input: { traitId: seedId, expectedRevision: 99, payload: input.payload } },
    { kind: 'stale', axis: 'trait', currentRevision: seed.revision },
  );
  await assertReadOnlyParity(
    { kind: 'edit', input: { ...input, payload: seed.payload } },
    { kind: 'noop' },
  );
  await assertReadOnlyParity(
    {
      kind: 'shared',
      input: { traitId: seedId, expectedRevision: seed.revision, payload: seed.payload },
    },
    { kind: 'noop' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rebind',
      input: { subjectId: id, kind: 'charter', expectedSubjectRevision: 0, targetTraitId: seedId },
    },
    { kind: 'noop' },
  );
  await assertReadOnlyParity(
    { kind: 'reset', input: { traitId: seedId, expectedRevision: seed.revision } },
    { kind: 'noop' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rollback',
      input: { traitId: seedId, expectedRevision: seed.revision, targetRevision: seed.revision },
    },
    { kind: 'noop' },
  );
  await assertReadOnlyParity(
    { kind: 'fork', input: { subjectId: 'general', kind: 'charter', expectedSubjectRevision: 99 } },
    { kind: 'forbidden' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rebind',
      input: {
        subjectId: 'general',
        kind: 'charter',
        expectedSubjectRevision: 99,
        targetTraitId: 'absent',
      },
    },
    { kind: 'forbidden' },
  );
  const fork = requireOk(
    await forkSubjectTrait(poolDb, { subjectId: id, kind: 'charter', expectedSubjectRevision: 0 }),
  );
  await assertReadOnlyParity(
    { kind: 'fork', input: { subjectId: id, kind: 'charter', expectedSubjectRevision: 1 } },
    { kind: 'invalid', message: 'binding already points at a subject-owned fork' },
  );
  await assertReadOnlyParity(
    { kind: 'reset', input: { traitId: fork.traitId, expectedRevision: 99 } },
    { kind: 'invalid', message: 'reset-to-seed is only legal for seed-lineage traits' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rebind',
      input: {
        subjectId: id,
        kind: 'charter',
        expectedSubjectRevision: 99,
        targetTraitId: 'absent',
      },
    },
    { kind: 'stale', axis: 'subject', currentRevision: 1 },
  );
  await assertReadOnlyParity(
    {
      kind: 'rebind',
      input: {
        subjectId: id,
        kind: 'charter',
        expectedSubjectRevision: 1,
        targetTraitId: 'absent',
      },
    },
    { kind: 'not_found' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rebind',
      input: {
        subjectId: id,
        kind: 'charter',
        expectedSubjectRevision: 1,
        targetTraitId: seedTraitId('general', 'scheduling'),
      },
    },
    { kind: 'invalid' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rollback',
      input: { traitId: fork.traitId, expectedRevision: 0, targetRevision: 999 },
    },
    { kind: 'invalid' },
  );
  await assertReadOnlyParity(
    {
      kind: 'rollback',
      input: { traitId: fork.traitId, expectedRevision: 99, targetRevision: 999 },
    },
    { kind: 'stale', axis: 'trait', currentRevision: 0 },
  );
});

it('fanout rejection names affected binders, and incompatible rollback snapshots write nothing', async () => {
  const a = await createCustom();
  const b = await createCustom('生物：共享校验');
  const judgeId = seedTraitId('general', 'judge_policy');
  const judge = await trait(judgeId);
  const bad = JudgePolicyTraitSchema.parse({
    ...JudgePolicyTraitSchema.parse(judge.payload),
    judgeCapabilities: ['judge_phantom_nope'],
  });
  const result = await assertReadOnlyParity(
    { kind: 'shared', input: { traitId: judgeId, expectedRevision: judge.revision, payload: bad } },
    { kind: 'invalid' },
  );
  if (result.kind !== 'invalid') throw new Error('expected fanout rejection');
  expect(result.issues?.map((issue) => issue.subjectId)).toEqual(
    expect.arrayContaining(['general', a, b]),
  );
  expect(result.issues?.every((issue) => issue.errors.length > 0)).toBe(true);
  await assertReadOnlyParity(
    {
      kind: 'edit',
      input: {
        subjectId: a,
        kind: 'judge_policy',
        expectedSubjectRevision: 0,
        expectedTraitRevision: judge.revision,
        payload: bad,
      },
    },
    { kind: 'invalid', issues: [{ subjectId: a, errors: expect.any(Array) }] },
  );
  const seed = await trait(seedId);
  await editSharedTrait(poolDb, {
    traitId: seedId,
    expectedRevision: seed.revision,
    payload: charter('新活内容。\n'.repeat(300)),
  });
  // Reproduce a historical snapshot whose payload no longer fits the current schema.
  await poolDb
    .update(schema.subject_trait_journal)
    .set({ payload: { nested: [{ missing: true }], methodology: null } })
    .where(
      and(
        eq(schema.subject_trait_journal.trait_id, seedId),
        eq(schema.subject_trait_journal.revision, seed.revision),
      ),
    );
  await assertReadOnlyParity(
    {
      kind: 'rollback',
      input: {
        traitId: seedId,
        expectedRevision: seed.revision + 1,
        targetRevision: seed.revision,
      },
    },
    { kind: 'invalid', message: expect.stringContaining('no longer parses') },
  );
});
