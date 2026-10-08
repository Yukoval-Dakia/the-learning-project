import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { BUILTIN_TRAIT_SEEDS, seedTraitId } from '@/subjects/builtin-trait-seeds';
import { CharterTraitSchema, SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { PATCH, RESET, RESTORE, RETIRE, VALIDATE } from '../api/admin-subject-control';
import {
  AdminSubjectCasBodySchema,
  AdminSubjectControlParamsSchema,
  type AdminSubjectControlResult,
  RenameAdminSubjectBodySchema,
  ValidateAdminSubjectInputSchema,
  renameAdminSubject,
  resetAdminSubject,
  restoreAdminSubject,
  retireAdminSubject,
  validateAdminSubject,
} from '../public';

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  hydrate: vi.fn(),
  order: [] as string[],
}));
vi.mock('@/db/client', () => {
  const client = {
    select: mocks.select,
    update: mocks.update,
    insert: mocks.insert,
    execute: mocks.execute,
    transaction: mocks.transaction,
  };
  mocks.transaction.mockImplementation(async (fn) => {
    mocks.order.push('transaction');
    const result = await fn(client);
    mocks.order.push('commit');
    return result;
  });
  return { db: client };
});
vi.mock('@/server/subjects/hydrate', async (original) => ({
  ...(await original<typeof import('@/server/subjects/hydrate')>()),
  hydrateSubjectRegistryFromDb: mocks.hydrate,
}));
vi.mock('@/server/r2', () => ({
  getR2: () => {
    throw new Error('Blob access forbidden');
  },
  createR2Client: () => {
    throw new Error('Blob access forbidden');
  },
}));

const row = {
  id: 'custom',
  display_name: '化学',
  display_name_norm: '化学',
  revision: 7,
  origin: 'custom',
  retired_at: null,
};
const input = { subjectId: row.id, expectedRevision: 7, displayName: '化学' };
function request(body: unknown): Request {
  return new Request('http://localhost/api/admin/subjects/custom', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
function resetCalls() {
  mocks.rows.length = 0;
  mocks.order.length = 0;
  vi.clearAllMocks();
}
beforeEach(() => {
  resetCalls();
  mocks.select.mockImplementation(() => {
    const rows = mocks.rows.shift();
    if (!rows) throw new Error('Unexpected select');
    const chain = Object.assign(Promise.resolve(rows), {
      from: () => chain,
      where: () => chain,
      innerJoin: () => chain,
      limit: () => chain,
      for: () => chain,
    });
    return chain;
  });
  mocks.update.mockImplementation(() => ({ set: () => ({ where: async () => {} }) }));
  mocks.insert.mockImplementation(() => ({ values: async () => {} }));
  mocks.execute.mockResolvedValue([]);
  mocks.hydrate.mockReset().mockImplementation(async () => {
    mocks.order.push('hydrate');
    return { hydrated: ['custom'], builtinFloor: [], skipped: [], removed: [] };
  });
});
afterEach(() => vi.restoreAllMocks());

const casOperations = [
  { name: 'retire', operation: retireAdminSubject, handler: RETIRE },
  { name: 'restore', operation: restoreAdminSubject, handler: RESTORE },
  { name: 'reset', operation: resetAdminSubject, handler: RESET },
];
describe.each(casOperations)('$name public operation and HTTP', ({ name, operation, handler }) => {
  const cases: {
    label: string;
    rows: unknown[][];
    result: AdminSubjectControlResult;
    status: number;
    body: unknown;
  }[] = [
    {
      label: 'unknown',
      rows: [[]],
      result: { kind: 'not_found', message: 'unknown subject "custom"' },
      status: 404,
      body: { error: 'unknown subject "custom"' },
    },
    {
      label: 'stale',
      rows: [[{ ...row, revision: 8 }]],
      result: { kind: 'stale', currentRevision: 8 },
      status: 409,
      body: { error: 'stale_revision', message: 'stale subject revision', currentRevision: 8 },
    },
    {
      label: 'noop',
      rows:
        name === 'retire'
          ? [[{ ...row, retired_at: new Date() }]]
          : name === 'restore'
            ? [[row]]
            : [
                [row],
                SUBJECT_TRAIT_KINDS.map((kind) => ({
                  kind,
                  traitId: seedTraitId('general', kind),
                })),
              ],
      result: { kind: 'noop', subjectRevision: 7 },
      status: 200,
      body: { subjectRevision: 7, noop: true },
    },
  ];
  it.each(cases)(
    'preserves $label without mutation or hydration',
    async ({ rows, result, status, body }) => {
      mocks.rows.push(...rows);
      expect(await operation(db, input)).toEqual(result);
      expect(mocks.hydrate).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      resetCalls();
      mocks.rows.push(...rows);
      const response = await handler(request(input), { id: 'custom' });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.hydrate).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );
  it('awaits one hydration after the writer transaction, using the explicit Db', async () => {
    const rows =
      name === 'retire'
        ? [[row]]
        : name === 'restore'
          ? [[{ ...row, retired_at: new Date() }], []]
          : [[row], [{ kind: 'charter', traitId: 'fork_charter' }]];
    // A distinct facade proves the operation does not fall back to the global singleton.
    const explicitDb = new Proxy(db, {});
    mocks.rows.push(...rows);
    expect(await operation(explicitDb, input)).toEqual({ kind: 'ok', subjectRevision: 8 });
    expect(mocks.order).toEqual(['transaction', 'commit', 'hydrate']);
    expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith(explicitDb);
    resetCalls();
    mocks.rows.push(...rows);
    const response = await handler(request(input), { id: 'custom' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subjectRevision: 8 });
    expect(mocks.order).toEqual(['transaction', 'commit', 'hydrate']);
  });
  it('does not retry transaction failure', async () => {
    const failure = new Error('DB unavailable');
    mocks.execute.mockRejectedValueOnce(failure);
    await expect(operation(db, input)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
  it('does not retry an unexpected hydration throw after commit', async () => {
    const rows =
      name === 'retire'
        ? [[row]]
        : name === 'restore'
          ? [[{ ...row, retired_at: new Date() }], []]
          : [[row], [{ kind: 'charter', traitId: 'fork_charter' }]];
    mocks.rows.push(...rows);
    const failure = new Error('unexpected hydration throw');
    mocks.hydrate.mockRejectedValueOnce(failure);
    await expect(operation(db, input)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.order).toEqual(['transaction', 'commit']);
    expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    resetCalls();
    mocks.rows.push(...rows);
    mocks.hydrate.mockRejectedValueOnce(failure);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handler(request(input), { id: 'custom' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'internal_error',
      message: 'Internal Server Error',
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).toHaveBeenCalledTimes(1);
  });
});

it.each([
  {
    displayName: '  ',
    rows: [],
    result: { kind: 'invalid', message: 'displayName must be non-empty' },
    status: 422,
    body: { error: 'displayName must be non-empty' },
  },
  {
    displayName: '化学',
    rows: [[row]],
    result: { kind: 'noop', subjectRevision: 7 },
    status: 200,
    body: { subjectRevision: 7, noop: true },
  },
  {
    displayName: '新科',
    rows: [[]],
    result: { kind: 'not_found', message: 'unknown subject "custom"' },
    status: 404,
    body: { error: 'unknown subject "custom"' },
  },
  {
    displayName: '新科',
    rows: [[{ ...row, revision: 9 }]],
    result: { kind: 'stale', currentRevision: 9 },
    status: 409,
    body: { error: 'stale_revision', message: 'stale subject revision', currentRevision: 9 },
  },
  {
    displayName: '新科',
    rows: [[row], [{ id: 'collision' }]],
    result: { kind: 'conflict', message: 'display name "新科" is already taken' },
    status: 409,
    body: { error: 'display name "新科" is already taken' },
  },
])(
  'rename preserves $result.kind and its full HTTP body',
  async ({ displayName, rows, result, status, body }) => {
    mocks.rows.push(...rows);
    expect(await renameAdminSubject(db, { ...input, displayName })).toEqual(result);
    resetCalls();
    mocks.rows.push(...rows);
    const response = await PATCH(request({ ...input, displayName }), { id: 'custom' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  },
);

it.each([
  { operation: retireAdminSubject, handler: RETIRE, message: 'general cannot be retired' },
  {
    operation: resetAdminSubject,
    handler: RESET,
    message: 'general bindings are structurally locked (P1-1)',
  },
])('keeps the general forbidden result at 422', async ({ operation, handler, message }) => {
  expect(await operation(db, { ...input, subjectId: 'general' })).toEqual({
    kind: 'forbidden',
    message,
  });
  const response = await handler(request(input), { id: 'general' });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: message });
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.hydrate).not.toHaveBeenCalled();
});

it('keeps restore conflicts at 409 without currentRevision', async () => {
  mocks.rows.push([{ ...row, retired_at: new Date() }], [{ id: 'collision' }]);
  expect(await restoreAdminSubject(db, input)).toEqual({
    kind: 'conflict',
    message: 'display name "化学" is now taken by another live subject',
  });
  resetCalls();
  mocks.rows.push([{ ...row, retired_at: new Date() }], [{ id: 'collision' }]);
  const response = await RESTORE(request(input), { id: 'custom' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'display name "化学" is now taken by another live subject',
  });
  expect(mocks.hydrate).not.toHaveBeenCalled();
});

it('keeps invalid builtin reset at 422', async () => {
  mocks.rows.push([{ ...row, origin: 'builtin' }]);
  expect(await resetAdminSubject(db, input)).toEqual({
    kind: 'invalid',
    message: 'builtin subject "custom" has no code seeds',
  });
  resetCalls();
  mocks.rows.push([{ ...row, origin: 'builtin' }]);
  const response = await RESET(request(input), { id: 'custom' });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: 'builtin subject "custom" has no code seeds' });
  expect(mocks.hydrate).not.toHaveBeenCalled();
});

it('renames through the public operation and HTTP, with one post-commit hydration', async () => {
  const args = { ...input, displayName: '  量子化学\n边界  ' };
  const explicitDb = new Proxy(db, {});
  mocks.rows.push([row], [], []);
  expect(await renameAdminSubject(explicitDb, args)).toEqual({ kind: 'ok', subjectRevision: 8 });
  expect(mocks.order).toEqual(['transaction', 'commit', 'hydrate']);
  expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith(explicitDb);
  resetCalls();
  mocks.rows.push([row], [], []);
  const response = await PATCH(request(args), { id: ' custom ' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ subjectRevision: 8 });
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.hydrate).toHaveBeenCalledExactlyOnceWith(db);
  expect(mocks.order).toEqual(['transaction', 'commit', 'hydrate']);
});

it('waits for hydration to resolve before returning a committed result', async () => {
  let completeHydration = () => {};
  const pendingHydration = new Promise<void>((resolve) => {
    completeHydration = resolve;
  });
  mocks.hydrate.mockImplementationOnce(async () => {
    mocks.order.push('hydrate');
    await pendingHydration;
  });
  mocks.rows.push([row], [], []);
  let returned = false;
  const pending = renameAdminSubject(db, { ...input, displayName: 'new name' }).then((result) => {
    returned = true;
    return result;
  });
  await vi.waitFor(() => expect(mocks.hydrate).toHaveBeenCalledTimes(1));
  expect(mocks.order).toEqual(['transaction', 'commit', 'hydrate']);
  expect(returned).toBe(false);
  completeHydration();
  expect(await pending).toEqual({ kind: 'ok', subjectRevision: 8 });
});

it('rename does not retry an unexpected hydration throw after commit', async () => {
  const failure = new Error('unexpected hydration throw');
  mocks.rows.push([row], [], []);
  mocks.hydrate.mockRejectedValueOnce(failure);
  await expect(renameAdminSubject(db, { ...input, displayName: 'new name' })).rejects.toBe(failure);
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.hydrate).toHaveBeenCalledTimes(1);
  expect(mocks.order).toEqual(['transaction', 'commit']);
});

it.each([{ operation: renameAdminSubject, handler: PATCH }, ...casOperations])(
  'does not repeat a failing writer through public or HTTP',
  async ({ operation, handler }) => {
    const args = { ...input, displayName: 'new name' };
    const failure = new Error('DB unavailable');
    mocks.execute.mockRejectedValueOnce(failure);
    await expect(operation(db, args)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).not.toHaveBeenCalled();
    resetCalls();
    mocks.execute.mockRejectedValueOnce(failure);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handler(request(args), { id: 'custom' });
    expect(response.status).toBe(500);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.hydrate).not.toHaveBeenCalled();
  },
);

const handlers = [PATCH, RETIRE, RESTORE, RESET, VALIDATE];
it.each(handlers)('validates id before reading JSON or accessing Db', async (handler) => {
  const req = request({});
  const text = vi.spyOn(req, 'text');
  const json = vi.spyOn(req, 'json');
  const response = await handler(req, { id: '  ' });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'subject id is required' });
  expect(text).not.toHaveBeenCalled();
  expect(json).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it.each(handlers)(
  'keeps malformed JSON before body validation and subject lookup',
  async (handler) => {
    const response = await handler(new Request('http://localhost', { method: 'POST', body: '{' }), {
      id: 'missing',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'request body must be valid JSON' });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);
it.each([PATCH, RETIRE, RESTORE, RESET])(
  'keeps invalid body before subject lookup',
  async (handler) => {
    const response = await handler(request({ expectedRevision: -1 }), { id: 'missing' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        handler === PATCH ? 'expectedRevision + displayName required' : 'expectedRevision required',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

function queueValidation() {
  mocks.rows.push(
    [{ displayName: '中性科目' }],
    SUBJECT_TRAIT_KINDS.map((kind) => ({
      kind,
      payload: BUILTIN_TRAIT_SEEDS.general[kind].payload,
    })),
  );
}
it('retains the complete assembled validation DTO and accepts rich partial overrides', async () => {
  const body = ValidateAdminSubjectInputSchema.parse({
    traitPayloadOverrides: {
      charter: {
        nested: [null, { evidence: '长文本\n'.repeat(500) }],
        ambiguity: ['unknown', false],
      },
    },
    ignored: true,
  });
  expect(
    Object.entries(body.traitPayloadOverrides ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key),
  ).toEqual(['charter']);
  queueValidation();
  const result = await validateAdminSubject(db, { subjectId: 'custom' });
  expect(result).toMatchObject({
    valid: true,
    errors: [],
    warnings: [],
    profile: { id: 'custom', displayName: '中性科目', version: 'preflight' },
  });
  resetCalls();
  queueValidation();
  const response = await VALIDATE(request({ ignored: true }), { id: 'custom' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(JSON.parse(JSON.stringify(result)));
  resetCalls();
  queueValidation();
  const invalid = await VALIDATE(request(body), { id: 'custom' });
  expect(invalid.status).toBe(200);
  expect(await invalid.json()).toMatchObject({ valid: false, warnings: [] });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.insert).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.hydrate).not.toHaveBeenCalled();
});
it.each([undefined, '', ' \n\t '])('accepts absent/blank validate body: %s', async (body) => {
  queueValidation();
  const response = await VALIDATE(new Request('http://localhost', { method: 'POST', body }), {
    id: 'custom',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ valid: true, profile: { id: 'custom' } });
  expect(mocks.hydrate).not.toHaveBeenCalled();
});
it.each([{ traitPayloadOverrides: { alien: {} } }, null, [], { traitPayloadOverrides: [] }])(
  'rejects invalid validate input before unknown subject lookup',
  async (body) => {
    expect(ValidateAdminSubjectInputSchema.safeParse(body).success).toBe(false);
    const response = await VALIDATE(request(body), { id: 'missing' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'traitPayloadOverrides must be keyed by trait kind',
    });
    expect(mocks.select).not.toHaveBeenCalled();
  },
);
it('keeps null validate result and unknown subject 404', async () => {
  mocks.rows.push([]);
  expect(await validateAdminSubject(db, { subjectId: 'missing' })).toBeNull();
  mocks.rows.push([]);
  const response = await VALIDATE(request({}), { id: 'missing' });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'unknown subject "missing"' });
  expect(mocks.hydrate).not.toHaveBeenCalled();
});
it('exports equivalent params/rename/CAS schemas without tightening non-strict objects', () => {
  expect(AdminSubjectControlParamsSchema.parse({ id: ' custom ', ignored: true })).toEqual({
    id: 'custom',
  });
  expect(
    RenameAdminSubjectBodySchema.parse({ expectedRevision: 0, displayName: '', ignored: true }),
  ).toEqual({ expectedRevision: 0, displayName: '' });
  expect(AdminSubjectCasBodySchema.parse({ expectedRevision: 0, ignored: true })).toEqual({
    expectedRevision: 0,
  });
  for (const revision of [-1, 0.5, '0', null, NaN, Infinity]) {
    expect(AdminSubjectCasBodySchema.safeParse({ expectedRevision: revision }).success).toBe(false);
    expect(
      RenameAdminSubjectBodySchema.safeParse({ expectedRevision: revision, displayName: '科目' })
        .success,
    ).toBe(false);
  }
});

it('matches full and partial parsed validate overrides without changing the running record semantics', async () => {
  const charter = CharterTraitSchema.parse({
    ...CharterTraitSchema.parse(BUILTIN_TRAIT_SEEDS.general.charter.payload),
    methodology: '证据、条件、失败分支。\n'.repeat(400),
  });
  const full = Object.fromEntries(
    SUBJECT_TRAIT_KINDS.map((kind) => [
      kind,
      kind === 'charter' ? charter : BUILTIN_TRAIT_SEEDS.general[kind].payload,
    ]),
  );
  for (const candidate of [
    { raw: full, valid: true },
    { raw: { charter }, valid: false },
  ]) {
    const parsed = ValidateAdminSubjectInputSchema.parse({ traitPayloadOverrides: candidate.raw });
    queueValidation();
    const result = await validateAdminSubject(new Proxy(db, {}), {
      subjectId: 'custom',
      ...parsed,
    });
    expect(result?.valid).toBe(candidate.valid);
    if (candidate.valid)
      expect(result?.profile?.promptFragments.methodology).toBe(charter.methodology);
    else {
      expect(Object.hasOwn(parsed.traitPayloadOverrides ?? {}, 'scheduling')).toBe(true);
      expect(parsed.traitPayloadOverrides?.scheduling).toBeUndefined();
      expect(result?.errors.length).toBeGreaterThan(0);
    }
    queueValidation();
    const response = await VALIDATE(request({ traitPayloadOverrides: candidate.raw }), {
      id: 'custom',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(result)));
  }
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.hydrate).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.insert).not.toHaveBeenCalled();
});

it('keeps builtin reset name conflicts at 409 without hydration or currentRevision', async () => {
  const rows = [
    [{ ...row, id: 'yuwen', origin: 'builtin', display_name: '古文' }],
    SUBJECT_TRAIT_KINDS.map((kind) => ({ kind, traitId: seedTraitId('yuwen', kind) })),
    [{ id: 'collision' }],
  ];
  mocks.rows.push(...rows);
  expect(await resetAdminSubject(db, { subjectId: 'yuwen', expectedRevision: 7 })).toEqual({
    kind: 'conflict',
    message: 'display name "语文" is already taken',
  });
  resetCalls();
  mocks.rows.push(...rows);
  const response = await RESET(request({ expectedRevision: 7 }), { id: 'yuwen' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'display name "语文" is already taken' });
  expect(mocks.hydrate).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.insert).not.toHaveBeenCalled();
});
