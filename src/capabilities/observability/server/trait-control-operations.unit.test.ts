import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { db } from '@/db/client';
import { BINDING, FORK, PUT as SUBJECT_PUT } from '../api/admin-subject-trait-write';
import { RESET_TO_SEED, ROLLBACK, PUT as SHARED_PUT } from '../api/admin-trait-write';
import {
  AdminSubjectTraitParamsSchema,
  AdminTraitWriteParamsSchema,
  EditSharedTraitInputSchema,
  EditSubjectTraitInputSchema,
  ForkSubjectTraitBodySchema,
  RebindSubjectTraitBodySchema,
  ResetAdminTraitBodySchema,
  RollbackAdminTraitBodySchema,
  type TraitWriteResult,
  editSharedTrait,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
  resetTraitToSeed,
  rollbackTrait,
} from '../public';

const mocks = vi.hoisted(() => ({
  editSubjectTrait: vi.fn(),
  forkSubjectTrait: vi.fn(),
  rebindSubjectTrait: vi.fn(),
  editSharedTrait: vi.fn(),
  rollbackTrait: vi.fn(),
  resetTraitToSeed: vi.fn(),
  hydrate: vi.fn(),
}));
vi.mock('@/server/subjects/trait-write', () => mocks);
vi.mock('@/server/subjects/hydrate', () => ({ hydrateSubjectRegistryFromDb: mocks.hydrate }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/server/r2', () => ({
  getR2: () => {
    throw new Error('Blob access forbidden');
  },
  createR2Client: () => {
    throw new Error('Blob access forbidden');
  },
}));

const payload = {
  nested: [null, { evidence: '条件、证据与未知。\n'.repeat(500) }],
  ambiguity: false,
};
const subjectInput = { subjectId: 'custom', kind: 'charter' as const, expectedSubjectRevision: 7 };
const subjectParams = { id: ' custom ', kind: 'charter' };
const sharedInput = { traitId: 'trait', expectedRevision: 4 };
const cases = [
  {
    name: 'subject edit',
    operation: (database: Db) =>
      editSubjectTrait(database, { ...subjectInput, expectedTraitRevision: 4, payload }),
    writer: mocks.editSubjectTrait,
    handler: SUBJECT_PUT,
    params: subjectParams,
    body: { expectedSubjectRevision: 7, expectedTraitRevision: 4, payload },
    input: { ...subjectInput, expectedTraitRevision: 4, payload },
    canonical: true,
    schemaError: 'expectedSubjectRevision + expectedTraitRevision + payload required',
  },
  {
    name: 'fork',
    operation: (database: Db) => forkSubjectTrait(database, subjectInput),
    writer: mocks.forkSubjectTrait,
    handler: FORK,
    params: subjectParams,
    body: { expectedSubjectRevision: 7 },
    input: subjectInput,
    canonical: true,
    schemaError: 'expectedSubjectRevision required',
  },
  {
    name: 'rebind',
    operation: (database: Db) =>
      rebindSubjectTrait(database, { ...subjectInput, targetTraitId: 'target' }),
    writer: mocks.rebindSubjectTrait,
    handler: BINDING,
    params: subjectParams,
    body: { expectedSubjectRevision: 7, targetTraitId: ' target ' },
    input: { ...subjectInput, targetTraitId: 'target' },
    canonical: false,
    schemaError: 'targetTraitId + expectedSubjectRevision required',
  },
  {
    name: 'shared edit',
    operation: (database: Db) => editSharedTrait(database, { ...sharedInput, payload }),
    writer: mocks.editSharedTrait,
    handler: SHARED_PUT,
    params: { id: ' trait ' },
    body: { expectedRevision: 4, payload },
    input: { ...sharedInput, payload },
    canonical: false,
    schemaError: 'expectedRevision + payload required',
  },
  {
    name: 'rollback',
    operation: (database: Db) => rollbackTrait(database, { ...sharedInput, targetRevision: 0 }),
    writer: mocks.rollbackTrait,
    handler: ROLLBACK,
    params: { id: ' trait ' },
    body: { expectedRevision: 4, targetRevision: 0 },
    input: { ...sharedInput, targetRevision: 0 },
    canonical: false,
    schemaError: 'expectedRevision + targetRevision required',
  },
  {
    name: 'reset',
    operation: (database: Db) => resetTraitToSeed(database, sharedInput),
    writer: mocks.resetTraitToSeed,
    handler: RESET_TO_SEED,
    params: { id: ' trait ' },
    body: { expectedRevision: 4 },
    input: sharedInput,
    canonical: false,
    schemaError: 'expectedRevision required',
  },
];
function request(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

const outcomes: { result: TraitWriteResult; status: number; body: unknown }[] = [
  {
    result: { kind: 'ok', traitId: 'trait/a ?漢', revision: 5, forked: true },
    status: 200,
    body: { traitId: 'trait/a ?漢', revision: 5, forked: true },
  },
  {
    result: { kind: 'ok', traitId: 'trait/a ?漢', revision: 5, forked: false },
    status: 200,
    body: { traitId: 'trait/a ?漢', revision: 5, forked: false },
  },
  {
    result: { kind: 'noop', traitId: 'trait/a ?漢', revision: 4 },
    status: 200,
    body: { traitId: 'trait/a ?漢', revision: 4, noop: true },
  },
  ...(['subject', 'trait'] as const).map((axis) => ({
    result: { kind: 'stale' as const, currentRevision: 9, axis },
    status: 409,
    body: { error: 'stale_revision', message: `stale ${axis} revision`, currentRevision: 9 },
  })),
  {
    result: { kind: 'not_found', message: 'unknown trait' },
    status: 404,
    body: { error: 'unknown trait' },
  },
  {
    result: { kind: 'forbidden', message: 'general locked' },
    status: 422,
    body: { error: 'general locked' },
  },
  {
    result: { kind: 'invalid', message: 'payload invalid' },
    status: 422,
    body: { error: 'payload invalid' },
  },
  {
    result: {
      kind: 'invalid',
      message: 'fanout rejected',
      issues: [{ subjectId: 'custom', errors: ['missing judge', 'ambiguous evidence'] }],
    },
    status: 422,
    body: {
      error: 'fanout rejected',
      issues: [{ subjectId: 'custom', errors: ['missing judge', 'ambiguous evidence'] }],
    },
  },
];
describe.each(cases)('$name public seam and HTTP parity', (candidate) => {
  it.each(outcomes)(
    'preserves $result.kind and the complete result',
    async ({ result, status, body }) => {
      const explicitDb = new Proxy(db, {});
      candidate.writer.mockResolvedValue(result);
      expect(await candidate.operation(explicitDb)).toBe(result);
      expect(candidate.writer).toHaveBeenCalledExactlyOnceWith(explicitDb, candidate.input);
      if (result.kind === 'ok') expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith(explicitDb);
      else expect(mocks.hydrate).not.toHaveBeenCalled();
      vi.clearAllMocks();
      const response = await candidate.handler(
        request({ ...candidate.body, ignored: true }),
        candidate.params,
      );
      const created = candidate.canonical && result.kind === 'ok' && result.forked;
      expect(response.status).toBe(created ? 201 : status);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get('Location')).toBe(
        candidate.canonical && (result.kind === 'ok' || result.kind === 'noop')
          ? '/api/admin/traits/trait%2Fa%20%3F%E6%BC%A2/journal'
          : null,
      );
      expect(candidate.writer).toHaveBeenCalledExactlyOnceWith(db, candidate.input);
      if (result.kind === 'ok') expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith(db);
      else expect(mocks.hydrate).not.toHaveBeenCalled();
    },
  );
  it('awaits the original writer then one hydration before returning', async () => {
    let finishWrite: (result: TraitWriteResult) => void = () => {};
    const pendingWrite = new Promise<TraitWriteResult>((resolve) => {
      finishWrite = resolve;
    });
    candidate.writer.mockReturnValueOnce(pendingWrite);
    let finishHydrate = () => {};
    mocks.hydrate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHydrate = resolve;
      }),
    );
    let returned = false;
    const pending = candidate.operation(db).then((value) => {
      returned = true;
      return value;
    });
    expect(mocks.hydrate).not.toHaveBeenCalled();
    const result: TraitWriteResult = { kind: 'ok', traitId: 'trait', revision: 5, forked: false };
    finishWrite(result);
    await vi.waitFor(() => expect(mocks.hydrate).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    finishHydrate();
    expect(await pending).toBe(result);
    expect(candidate.writer).toHaveBeenCalledTimes(1);
  });
  it('does not replay a writer failure or an unexpected hydration throw', async () => {
    const failure = new Error('DB unavailable');
    candidate.writer.mockRejectedValueOnce(failure);
    await expect(candidate.operation(db)).rejects.toBe(failure);
    expect(candidate.writer).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).not.toHaveBeenCalled();
    vi.clearAllMocks();
    candidate.writer.mockResolvedValue({
      kind: 'ok',
      traitId: 'trait',
      revision: 5,
      forked: false,
    });
    mocks.hydrate.mockRejectedValueOnce(failure);
    await expect(candidate.operation(db)).rejects.toBe(failure);
    expect(candidate.writer).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    candidate.writer.mockRejectedValueOnce(failure);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await candidate.handler(request(candidate.body), candidate.params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'internal_error',
      message: 'Internal Server Error',
    });
    expect(candidate.writer).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
  it('validates params before JSON, then JSON before schema, then schema before domain', async () => {
    const req = request({});
    const json = vi.spyOn(req, 'json');
    const invalidParams = await candidate.handler(req, { id: ' ', kind: 'alien' });
    expect(invalidParams.status).toBe(400);
    expect(await invalidParams.json()).toEqual({
      error:
        candidate.canonical || candidate.handler === BINDING
          ? 'subject id + trait kind (one of: charter, judge_policy, cause_taxonomy, source_policy, render_theme, scheduling) required'
          : 'trait id is required',
    });
    expect(json).not.toHaveBeenCalled();
    const malformed = await candidate.handler(
      new Request('http://localhost', { method: 'POST', body: '{' }),
      candidate.params,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'request body must be valid JSON' });
    const invalidBody = await candidate.handler(
      request({ expectedRevision: -1, expectedSubjectRevision: -1 }),
      candidate.params,
    );
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toEqual({ error: candidate.schemaError });
    expect(candidate.writer).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
});

it.each([cases[0], cases[3]])(
  'passes missing and arbitrary edit payloads to the domain for 422',
  async (candidate) => {
    if (!candidate) throw new Error('edit descriptor required');
    candidate.writer.mockResolvedValue({ kind: 'invalid', message: 'strict payload rejection' });
    for (const value of [undefined, null, [], payload]) {
      const response = await candidate.handler(
        request({ ...candidate.body, payload: value }),
        candidate.params,
      );
      expect(response.status).toBe(422);
      expect(candidate.writer).toHaveBeenLastCalledWith(db, { ...candidate.input, payload: value });
    }
    expect(mocks.hydrate).not.toHaveBeenCalled();
  },
);

it('exports non-strict runtime schemas with the original trim/revision/payload contract', () => {
  expect(
    AdminSubjectTraitParamsSchema.parse({ id: ' custom ', kind: 'charter', ignored: true }),
  ).toEqual({ id: 'custom', kind: 'charter' });
  expect(AdminTraitWriteParamsSchema.parse({ id: ' trait ', ignored: true })).toEqual({
    id: 'trait',
  });
  expect(
    EditSubjectTraitInputSchema.parse({
      expectedSubjectRevision: 0,
      expectedTraitRevision: 0,
      ignored: true,
    }),
  ).toEqual({ expectedSubjectRevision: 0, expectedTraitRevision: 0 });
  expect(EditSharedTraitInputSchema.parse({ expectedRevision: 0, payload, ignored: true })).toEqual(
    { expectedRevision: 0, payload },
  );
  const schemaCases = [
    {
      schema: EditSubjectTraitInputSchema,
      body: { expectedSubjectRevision: 0, expectedTraitRevision: 0 },
      axes: ['expectedSubjectRevision', 'expectedTraitRevision'],
    },
    {
      schema: EditSharedTraitInputSchema,
      body: { expectedRevision: 0 },
      axes: ['expectedRevision'],
    },
    {
      schema: ForkSubjectTraitBodySchema,
      body: { expectedSubjectRevision: 0 },
      axes: ['expectedSubjectRevision'],
    },
    {
      schema: RebindSubjectTraitBodySchema,
      body: { expectedSubjectRevision: 0, targetTraitId: 'target' },
      axes: ['expectedSubjectRevision'],
    },
    {
      schema: RollbackAdminTraitBodySchema,
      body: { expectedRevision: 0, targetRevision: 0 },
      axes: ['expectedRevision', 'targetRevision'],
    },
    {
      schema: ResetAdminTraitBodySchema,
      body: { expectedRevision: 0 },
      axes: ['expectedRevision'],
    },
  ];
  for (const { schema, body, axes } of schemaCases) {
    expect(schema.parse({ ...body, ignored: true })).toEqual(body);
    for (const axis of axes)
      for (const value of [-1, 0.5, '0', null, NaN, Infinity])
        expect(schema.safeParse({ ...body, [axis]: value }).success).toBe(false);
  }
});
