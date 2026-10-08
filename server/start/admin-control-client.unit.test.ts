// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { startAdminControlClient } from './admin-control-client';
import {
  controlConfig,
  controlJournal,
  controlReceipt,
  controlSubjects,
  controlTraits,
} from './admin-control-test-fixtures';

const rpc = vi.hoisted(() => ({
  getStartAdminConfig: vi.fn(),
  patchStartAdminConfig: vi.fn(),
  resetStartAdminConfig: vi.fn(),
  getStartAdminSubjects: vi.fn(),
  getStartAdminSubjectTraits: vi.fn(),
  getStartAdminTraits: vi.fn(),
  getStartAdminTraitJournal: vi.fn(),
  renameStartAdminSubject: vi.fn(),
  retireStartAdminSubject: vi.fn(),
  restoreStartAdminSubject: vi.fn(),
  resetStartAdminSubject: vi.fn(),
  validateStartAdminSubject: vi.fn(),
  editStartAdminSubjectTrait: vi.fn(),
  forkStartAdminSubjectTrait: vi.fn(),
  rebindStartAdminSubjectTrait: vi.fn(),
  editStartAdminSharedTrait: vi.fn(),
  rollbackStartAdminTrait: vi.fn(),
  resetStartAdminTraitToSeed: vi.fn(),
}));
vi.mock('./admin-control-function', () => rpc);
const calls = [
  {
    name: 'getStartAdminConfig',
    method: 'GET',
    data: undefined,
    fixture: JSON.stringify(controlConfig()),
    call: () => startAdminControlClient.getConfig(),
  },
  {
    name: 'patchStartAdminConfig',
    method: 'POST',
    data: {
      changes: [{ action: 'set', key: 'locale.learner', value: 'en' }],
      note: '保留条件\n和歧义',
    },
    fixture: controlReceipt,
    call: () =>
      startAdminControlClient.patchConfig({
        changes: [{ action: 'set', key: 'locale.learner', value: 'en' }],
        note: '保留条件\n和歧义',
      }),
  },
  {
    name: 'resetStartAdminConfig',
    method: 'POST',
    data: { keys: ['locale.learner'] },
    fixture: controlReceipt,
    call: () => startAdminControlClient.resetConfig({ keys: ['locale.learner'] }),
  },
  {
    name: 'getStartAdminSubjects',
    method: 'GET',
    data: undefined,
    fixture: controlSubjects,
    call: () => startAdminControlClient.getSubjects(),
  },
  {
    name: 'getStartAdminSubjectTraits',
    method: 'GET',
    data: { subjectId: 'custom' },
    fixture: JSON.stringify(controlTraits),
    call: () => startAdminControlClient.getSubjectTraits({ subjectId: 'custom' }),
  },
  {
    name: 'getStartAdminTraits',
    method: 'GET',
    data: { kind: 'charter' },
    fixture: {
      traits: [
        {
          traitId: 'seed/charter',
          origin: 'builtin',
          ownerSubjectId: null,
          seedVersion: '1.0.0',
          revision: 3,
          boundBy: ['general', 'custom'],
        },
      ],
    },
    call: () => startAdminControlClient.getTraits({ kind: 'charter' }),
  },
  {
    name: 'getStartAdminTraitJournal',
    method: 'GET',
    data: { traitId: 'seed/charter', limit: '200', cursor: 'opaque' },
    fixture: controlJournal,
    call: () =>
      startAdminControlClient.getTraitJournal({
        traitId: 'seed/charter',
        limit: '200',
        cursor: 'opaque',
      }),
  },
  {
    name: 'renameStartAdminSubject',
    method: 'POST',
    data: { subjectId: 'custom', expectedRevision: 8, displayName: '新名称' },
    fixture: { subjectRevision: 9 },
    call: () =>
      startAdminControlClient.renameSubject({
        subjectId: 'custom',
        expectedRevision: 8,
        displayName: '新名称',
      }),
  },
  {
    name: 'retireStartAdminSubject',
    method: 'POST',
    data: { subjectId: 'custom', expectedRevision: 8 },
    fixture: { subjectRevision: 9 },
    call: () => startAdminControlClient.retireSubject({ subjectId: 'custom', expectedRevision: 8 }),
  },
  {
    name: 'restoreStartAdminSubject',
    method: 'POST',
    data: { subjectId: 'custom', expectedRevision: 8 },
    fixture: { subjectRevision: 9 },
    call: () =>
      startAdminControlClient.restoreSubject({ subjectId: 'custom', expectedRevision: 8 }),
  },
  {
    name: 'resetStartAdminSubject',
    method: 'POST',
    data: { subjectId: 'custom', expectedRevision: 8 },
    fixture: { subjectRevision: 9 },
    call: () => startAdminControlClient.resetSubject({ subjectId: 'custom', expectedRevision: 8 }),
  },
  {
    name: 'validateStartAdminSubject',
    method: 'POST',
    data: {
      subjectId: 'custom',
      traitPayloadOverrides: { charter: controlTraits.bindings[0].payload },
    },
    fixture: { valid: false, errors: ['候选不兼容'], warnings: ['保留'] },
    call: () =>
      startAdminControlClient.validateSubject({
        subjectId: 'custom',
        traitPayloadOverrides: { charter: controlTraits.bindings[0].payload },
      }),
  },
  {
    name: 'editStartAdminSubjectTrait',
    method: 'POST',
    data: {
      subjectId: 'custom',
      kind: 'charter',
      expectedSubjectRevision: 8,
      expectedTraitRevision: 3,
      payload: controlTraits.bindings[0].payload,
    },
    fixture: {
      traitId: 'fork/charter',
      revision: 4,
      forked: true,
      status: 201,
      canonicalLocation: '/api/admin/traits/fork%2Fcharter/journal',
    },
    call: () =>
      startAdminControlClient.editSubjectTrait({
        subjectId: 'custom',
        kind: 'charter',
        expectedSubjectRevision: 8,
        expectedTraitRevision: 3,
        payload: controlTraits.bindings[0].payload,
      }),
  },
  {
    name: 'forkStartAdminSubjectTrait',
    method: 'POST',
    data: { subjectId: 'custom', kind: 'charter', expectedSubjectRevision: 8 },
    fixture: {
      traitId: 'fork/charter',
      revision: 4,
      forked: true,
      status: 201,
      canonicalLocation: '/api/admin/traits/fork%2Fcharter/journal',
    },
    call: () =>
      startAdminControlClient.forkSubjectTrait({
        subjectId: 'custom',
        kind: 'charter',
        expectedSubjectRevision: 8,
      }),
  },
  {
    name: 'rebindStartAdminSubjectTrait',
    method: 'POST',
    data: {
      subjectId: 'custom',
      kind: 'charter',
      expectedSubjectRevision: 8,
      targetTraitId: 'target',
    },
    fixture: { traitId: 'fork/charter', revision: 4, forked: false, status: 200 },
    call: () =>
      startAdminControlClient.rebindSubjectTrait({
        subjectId: 'custom',
        kind: 'charter',
        expectedSubjectRevision: 8,
        targetTraitId: 'target',
      }),
  },
  {
    name: 'editStartAdminSharedTrait',
    method: 'POST',
    data: {
      traitId: 'seed/charter',
      expectedRevision: 3,
      payload: controlTraits.bindings[0].payload,
    },
    fixture: { traitId: 'fork/charter', revision: 4, forked: false, status: 200 },
    call: () =>
      startAdminControlClient.editSharedTrait({
        traitId: 'seed/charter',
        expectedRevision: 3,
        payload: controlTraits.bindings[0].payload,
      }),
  },
  {
    name: 'rollbackStartAdminTrait',
    method: 'POST',
    data: { traitId: 'seed/charter', expectedRevision: 3, targetRevision: 1 },
    fixture: { traitId: 'fork/charter', revision: 4, forked: false, status: 200 },
    call: () =>
      startAdminControlClient.rollbackTrait({
        traitId: 'seed/charter',
        expectedRevision: 3,
        targetRevision: 1,
      }),
  },
  {
    name: 'resetStartAdminTraitToSeed',
    method: 'POST',
    data: { traitId: 'seed/charter', expectedRevision: 3 },
    fixture: { traitId: 'fork/charter', revision: 4, forked: false, status: 200 },
    call: () =>
      startAdminControlClient.resetTraitToSeed({ traitId: 'seed/charter', expectedRevision: 3 }),
  },
] as const;
beforeEach(() => {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'control-token');
  vi.stubGlobal('fetch', vi.fn());
  for (const entry of calls)
    rpc[entry.name].mockImplementation(async (options) => {
      const response = await options.fetch(`http://unit.test/_serverFn/${entry.name}`, {
        method: entry.method,
        headers: { 'x-tsr-serverFn': 'true' },
        ...(entry.method === 'POST' ? { body: JSON.stringify(options.data) } : {}),
      });
      return response.json();
    });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
describe('admin controls RPC transport', () => {
  it.each(calls)(
    'uses $name once, preserves all data and token authority without HTTP fallback',
    async (entry) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(entry.fixture));
      expect(await entry.call()).toEqual(
        typeof entry.fixture === 'string' ? JSON.parse(entry.fixture) : entry.fixture,
      );
      expect(rpc[entry.name]).toHaveBeenCalledOnce();
      expect(rpc[entry.name].mock.calls[0][0].data).toEqual(entry.data);
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(String(url)).toContain(`/_serverFn/${entry.name}`);
      expect(init?.method).toBe(entry.method);
      expect(new Headers(init?.headers).get('x-internal-token')).toBe('control-token');
    },
  );
  it.each(calls)('denies $name on 401, clears token, and never replays', async (entry) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    await expect(entry.call()).rejects.toBeInstanceOf(ApiAuthError);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    {
      status: 409,
      body: { error: 'stale_revision', message: 'stale trait revision', currentRevision: 12 },
      details: { currentRevision: 12 },
    },
    { status: 409, body: { error: 'name already used' }, details: {} },
    {
      status: 422,
      body: {
        error: 'fanout invalid',
        issues: [{ subjectId: 'general', errors: ['嵌套条件不兼容'] }],
      },
      details: { issues: [{ subjectId: 'general', errors: ['嵌套条件不兼容'] }] },
    },
    {
      status: 503,
      body: { error: 'contract_epoch_fenced', reason: 'unavailable' },
      details: { reason: 'unavailable' },
    },
  ])(
    'preserves ApiError details at $status without mutation retry',
    async ({ status, body, details }) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(body, { status }));
      const error: unknown = await startAdminControlClient
        .editSharedTrait({ traitId: 'seed', expectedRevision: 3 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('Expected ApiError');
      expect(error.status).toBe(status);
      expect(error.details).toEqual(details);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});
