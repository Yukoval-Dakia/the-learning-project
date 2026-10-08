import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { createStartAdminControlReader } from './admin-control-reader';

const seams = vi.hoisted(() => ({
  database: vi.fn(),
  hydrate: vi.fn(),
  subjects: vi.fn<typeof import('@/capabilities/observability/public').listAdminSubjects>(),
  bindings: vi.fn<typeof import('@/capabilities/observability/public').getAdminSubjectTraits>(),
  catalog: vi.fn<typeof import('@/capabilities/observability/public').listAdminTraits>(),
  journal: vi.fn<typeof import('@/capabilities/observability/public').getTraitJournalPage>(),
  renameSubject: vi.fn<typeof import('@/server/subjects/subject-control-write').renameSubject>(),
  retireSubject: vi.fn<typeof import('@/server/subjects/subject-control-write').retireSubject>(),
  restoreSubject: vi.fn<typeof import('@/server/subjects/subject-control-write').restoreSubject>(),
  resetSubject: vi.fn<typeof import('@/server/subjects/subject-control-write').resetSubject>(),
  validateSubject:
    vi.fn<typeof import('@/server/subjects/subject-control-write').validateSubject>(),
  editSubjectTrait: vi.fn<typeof import('@/server/subjects/trait-write').editSubjectTrait>(),
  forkSubjectTrait: vi.fn<typeof import('@/server/subjects/trait-write').forkSubjectTrait>(),
  rebindSubjectTrait: vi.fn<typeof import('@/server/subjects/trait-write').rebindSubjectTrait>(),
  editSharedTrait: vi.fn<typeof import('@/server/subjects/trait-write').editSharedTrait>(),
  rollbackTrait: vi.fn<typeof import('@/server/subjects/trait-write').rollbackTrait>(),
  resetTraitToSeed: vi.fn<typeof import('@/server/subjects/trait-write').resetTraitToSeed>(),
}));
vi.mock('@/db/client', () => ({
  get db() {
    seams.database();
    return { name: 'owned-unit-pool' };
  },
}));
vi.mock('@/server/subjects/hydrate', () => ({ hydrateSubjectRegistryFromDb: seams.hydrate }));
vi.mock('@/server/subjects/admin-read', () => ({
  listAdminSubjects: seams.subjects,
  getAdminSubjectTraits: seams.bindings,
  listAdminTraits: seams.catalog,
  getTraitJournalPage: seams.journal,
}));
vi.mock('@/server/subjects/subject-control-write', () => ({
  renameSubject: seams.renameSubject,
  retireSubject: seams.retireSubject,
  restoreSubject: seams.restoreSubject,
  resetSubject: seams.resetSubject,
  validateSubject: seams.validateSubject,
}));
vi.mock('@/server/subjects/trait-write', () => ({
  editSubjectTrait: seams.editSubjectTrait,
  forkSubjectTrait: seams.forkSubjectTrait,
  rebindSubjectTrait: seams.rebindSubjectTrait,
  editSharedTrait: seams.editSharedTrait,
  rollbackTrait: seams.rollbackTrait,
  resetTraitToSeed: seams.resetTraitToSeed,
}));

const writes = [
  [
    'renameSubject',
    { subjectId: '  custom ', expectedRevision: 8, displayName: '含条件与歧义的科目' },
  ],
  ['retireSubject', { subjectId: 'custom', expectedRevision: 8 }],
  ['restoreSubject', { subjectId: 'custom', expectedRevision: 8 }],
  ['resetSubject', { subjectId: 'custom', expectedRevision: 8 }],
  [
    'editSubjectTrait',
    {
      subjectId: 'custom',
      kind: 'charter',
      expectedSubjectRevision: 8,
      expectedTraitRevision: 3,
      payload: {
        methodology: '证据与限制。'.repeat(100),
        noteTemplate: { sections: [{ title: '条件', body: ['unknown', null] }] },
      },
    },
  ],
  ['forkSubjectTrait', { subjectId: 'custom', kind: 'charter', expectedSubjectRevision: 8 }],
  [
    'rebindSubjectTrait',
    { subjectId: 'custom', kind: 'charter', expectedSubjectRevision: 8, targetTraitId: ' target ' },
  ],
  [
    'editSharedTrait',
    {
      traitId: ' seed/charter ',
      expectedRevision: 3,
      payload: { methodology: '共享', nested: { notes: [null, true] } },
    },
  ],
  ['rollbackTrait', { traitId: 'seed/charter', expectedRevision: 3, targetRevision: 1 }],
  ['resetTraitToSeed', { traitId: 'seed/charter', expectedRevision: 3 }],
] as const;
type Controls = Awaited<ReturnType<typeof createStartAdminControlReader>>;
// Deliberately exercise unknown RPC input, including missing fields, through each
// real adapter method rather than weakening its production type.
async function invoke(controls: Controls, name: string, input: unknown): Promise<unknown> {
  const method = z
    .function({ input: z.tuple([z.unknown()]), output: z.promise(z.unknown()) })
    .parse(Reflect.get(controls, name));
  return method(input);
}
async function denied(call: Promise<unknown>, status: number) {
  const error: unknown = await call.catch((e: unknown) => e);
  if (!(error instanceof Response)) throw new Error(`Expected Response, received ${String(error)}`);
  expect(error.status).toBe(status);
  return error.json();
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ['renameSubject', 'retireSubject', 'restoreSubject', 'resetSubject'] as const)
    seams[name].mockResolvedValue({ kind: 'ok', subjectRevision: 9 });
  for (const name of [
    'editSubjectTrait',
    'forkSubjectTrait',
    'rebindSubjectTrait',
    'editSharedTrait',
    'rollbackTrait',
    'resetTraitToSeed',
  ] as const)
    seams[name].mockResolvedValue({
      kind: 'ok',
      traitId: 'trait/带空格',
      revision: 4,
      forked: name === 'forkSubjectTrait' || name === 'editSubjectTrait',
    });
  seams.validateSubject.mockResolvedValue({
    valid: false,
    errors: ['候选不兼容'],
    warnings: ['历史保留'],
  });
  seams.journal.mockResolvedValue({ rows: [], next_cursor: null });
  seams.catalog.mockResolvedValue([]);
  seams.subjects.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());
describe('canonical Start adapters reuse public operations and their hydration', () => {
  it.each(writes)(
    '%s uses one owned pool transaction seam and one existing postcommit hydrate',
    async (name, input) => {
      const database = db;
      const controls = await createStartAdminControlReader({ database });
      seams.database.mockClear();
      const result = await invoke(controls, name, { ...input, extra: 'non-strict HTTP field' });
      expect(seams[name]).toHaveBeenCalledOnce();
      expect(seams[name].mock.calls[0][0]).toBe(database);
      expect(seams[name].mock.calls[0][1]).toMatchObject(
        'subjectId' in input
          ? { subjectId: input.subjectId.trim() }
          : { traitId: input.traitId.trim() },
      );
      expect(seams[name].mock.calls[0][1]).not.toHaveProperty('extra');
      expect(seams.hydrate).toHaveBeenCalledExactlyOnceWith(database);
      expect(seams[name].mock.invocationCallOrder[0]).toBeLessThan(
        seams.hydrate.mock.invocationCallOrder[0],
      );
      expect(seams.database).not.toHaveBeenCalled();
      if (name === 'editSubjectTrait' || name === 'forkSubjectTrait')
        expect(result).toMatchObject({
          status: 201,
          canonicalLocation: '/api/admin/traits/trait%2F%E5%B8%A6%E7%A9%BA%E6%A0%BC/journal',
        });
      else expect(result).not.toHaveProperty('canonicalLocation');
    },
  );
  it.each(writes)(
    '%s preserves stale errors and never hydrates or replays',
    async (name, input) => {
      if ('traitId' in input || 'kind' in input) {
        // Parse the result as the actual writer result union through its applicable branch.
        if (
          name === 'renameSubject' ||
          name === 'retireSubject' ||
          name === 'restoreSubject' ||
          name === 'resetSubject'
        )
          throw new Error('Unexpected control');
        seams[name].mockResolvedValue({ kind: 'stale', axis: 'trait', currentRevision: 12 });
      } else {
        if (
          name !== 'renameSubject' &&
          name !== 'retireSubject' &&
          name !== 'restoreSubject' &&
          name !== 'resetSubject'
        )
          throw new Error('Unexpected trait');
        seams[name].mockResolvedValue({ kind: 'stale', currentRevision: 12 });
      }
      const controls = await createStartAdminControlReader({ database: db });
      expect(await denied(invoke(controls, name, input), 409)).toMatchObject({
        error: 'stale_revision',
        currentRevision: 12,
      });
      expect(seams[name]).toHaveBeenCalledOnce();
      expect(seams.hydrate).not.toHaveBeenCalled();
    },
  );
  it('retains conflict without currentRevision and fanout issues without cropping', async () => {
    const controls = await createStartAdminControlReader({ database: db });
    seams.renameSubject.mockResolvedValue({ kind: 'conflict', message: 'name already used' });
    expect(
      await denied(
        controls.renameSubject({ subjectId: 'x', expectedRevision: 0, displayName: 'taken' }),
        409,
      ),
    ).toEqual({ error: 'name already used' });
    seams.editSharedTrait.mockResolvedValue({
      kind: 'invalid',
      message: 'fanout invalid',
      issues: [{ subjectId: 'general', errors: ['nested incompatibility'] }],
    });
    expect(
      await denied(controls.editSharedTrait({ traitId: 'seed', expectedRevision: 0 }), 422),
    ).toMatchObject({ issues: [{ subjectId: 'general', errors: ['nested incompatibility'] }] });
    expect(seams.hydrate).not.toHaveBeenCalled();
  });
  it('passes missing edit payloads to the original writer for 422 and keeps validation false as success', async () => {
    const controls = await createStartAdminControlReader({ database: db });
    seams.editSubjectTrait.mockResolvedValue({
      kind: 'invalid',
      message: 'invalid charter payload',
    });
    seams.editSharedTrait.mockResolvedValue({
      kind: 'invalid',
      message: 'invalid charter payload',
    });
    await denied(
      controls.editSubjectTrait({
        subjectId: 'x',
        kind: 'charter',
        expectedSubjectRevision: 0,
        expectedTraitRevision: 0,
      }),
      422,
    );
    await denied(controls.editSharedTrait({ traitId: 'seed', expectedRevision: 0 }), 422);
    expect(seams.editSubjectTrait.mock.calls[0][1]).toHaveProperty('payload', undefined);
    expect(seams.editSharedTrait.mock.calls[0][1]).toHaveProperty('payload', undefined);
    expect(await controls.validateSubject({ subjectId: 'x' })).toEqual({
      valid: false,
      errors: ['候选不兼容'],
      warnings: ['历史保留'],
    });
    expect(seams.hydrate).not.toHaveBeenCalled();
  });
  it.each(writes)('%s rejects bad revisions before acquiring a database', async (name, input) => {
    const controls = await createStartAdminControlReader();
    seams.database.mockClear();
    await denied(
      invoke(controls, name, { ...input, expectedRevision: -1, expectedSubjectRevision: -1 }),
      400,
    );
    expect(seams[name]).not.toHaveBeenCalled();
    expect(seams.database).not.toHaveBeenCalled();
  });
  it('keeps noop status/location and does not hydrate', async () => {
    const controls = await createStartAdminControlReader({ database: db });
    seams.editSubjectTrait.mockResolvedValue({
      kind: 'noop',
      traitId: 'seed/charter',
      revision: 3,
    });
    expect(
      await controls.editSubjectTrait({
        subjectId: 'x',
        kind: 'charter',
        expectedSubjectRevision: 1,
        expectedTraitRevision: 3,
      }),
    ).toEqual({
      traitId: 'seed/charter',
      revision: 3,
      noop: true,
      status: 200,
      canonicalLocation: '/api/admin/traits/seed%2Fcharter/journal',
    });
    expect(seams.hydrate).not.toHaveBeenCalled();
  });
  it('preserves journal default/cap/cursor, empty versus missing, canonical and legacy envelopes', async () => {
    const controls = await createStartAdminControlReader({ database: db });
    expect(await controls.getTraitJournal({ traitId: ' seed ' })).toEqual({
      data: [],
      page: { limit: 100, next_cursor: null },
      journal: [],
      next_cursor: null,
    });
    expect(seams.journal).toHaveBeenLastCalledWith(db, 'seed', { limit: 100, cursor: undefined });
    await controls.getTraitJournal({ traitId: 'seed', limit: '999', cursor: 'opaque' });
    expect(seams.journal).toHaveBeenLastCalledWith(db, 'seed', { limit: 200, cursor: 'opaque' });
    for (const limit of ['bad', '', '0', '-1', '2.5'])
      await denied(controls.getTraitJournal({ traitId: 'seed', limit }), 400);
    seams.journal.mockRejectedValueOnce(
      new ApiError('invalid_cursor', 'invalid trait cursor', 400),
    );
    expect(
      await denied(controls.getTraitJournal({ traitId: 'seed', cursor: 'bad' }), 400),
    ).toMatchObject({ error: 'invalid_cursor' });
    seams.journal.mockResolvedValueOnce(null);
    await denied(controls.getTraitJournal({ traitId: 'missing' }), 404);
  });
  it('retains kind filtering and readable invalid live payloads with degradation metadata', async () => {
    const controls = await createStartAdminControlReader({ database: db });
    await controls.getTraits({ kind: 'judge_policy' });
    expect(seams.catalog).toHaveBeenLastCalledWith(db, 'judge_policy');
    await denied(invoke(controls, 'getTraits', { kind: 'alien' }), 400);
    const dto = {
      subjectRevision: 8,
      bindings: [
        {
          kind: 'charter',
          traitId: 'bad',
          origin: 'custom',
          ownerSubjectId: 'x',
          seedVersion: null,
          revision: 5,
          effectiveRevision: 'seed:1.0',
          degraded: 'code_seed',
          payload: { invalid: { ambiguity: ['retain', null], long: '证据'.repeat(100) } },
          sharedBy: ['x', 'retired'],
        },
      ],
    } satisfies NonNullable<
      Awaited<
        ReturnType<typeof import('@/capabilities/observability/public').getAdminSubjectTraits>
      >
    >;
    // Boundary fixture is validated against the actual shared schema before injection.
    const { SubjectTraitsWireSchema } = await import('@/capabilities/observability/ui-public');
    SubjectTraitsWireSchema.parse(dto);
    seams.bindings.mockResolvedValue(dto);
    expect(await controls.getSubjectTraits({ subjectId: 'x' })).toEqual(dto);
  });
});
