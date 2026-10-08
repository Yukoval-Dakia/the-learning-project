import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/kernel/http';
import { PATCH, RESET } from '../api/admin-config-write';
import {
  AdminConfigResetBodySchema,
  type AdminConfigResetInput,
  AdminConfigWriteBodySchema,
  type AdminConfigWriteInput,
  AdminConfigWriteResponseSchema,
  type AdminConfigWriteResult,
  type AdminConfigWriter,
  patchAdminConfig,
  resetAdminConfig,
  setAdminConfigWriter,
} from '../public';
import { __resetAdminConfigWriterForTests } from './admin-config-writer';

// Unrelated public exports may load these modules, but no test may use a DB or blob client.
vi.mock('@/db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('DB access forbidden in config unit tests');
      },
    },
  ),
}));
vi.mock('@/server/r2', () => ({
  getR2: () => {
    throw new Error('Blob access forbidden in config unit tests');
  },
  createR2Client: () => {
    throw new Error('Blob access forbidden in config unit tests');
  },
}));

const input: AdminConfigWriteInput = {
  changes: [
    { action: 'set', key: 'task.QuizGenTask.provider', value: 'opencode-go' },
    { action: 'set', key: 'task.QuizGenTask.model', value: 'glm-5.3-flash' },
    {
      action: 'set',
      key: 'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
      value: {
        lanes: {
          chat: {
            allowed: true,
            attempts: [1, 3, null],
            evidence: '保留原始条件与歧义。\n'.repeat(500),
          },
          vision: { fallback: false, policy: { labels: ['保留', '待核'], unknown: null } },
        },
      },
    },
    { action: 'clear', key: 'task.AttributionTask.budget' },
  ],
  note: '  操作说明，保留换行和空白。\n'.repeat(80),
};
const resetInput: AdminConfigResetInput = {
  keys: ['task.QuizGenTask.provider', 'task.QuizGenTask.model', 'task.AttributionTask.budget'],
  note: input.note,
};
const receipt: AdminConfigWriteResult = {
  committed_epoch: 83,
  snapshot_epoch: 79,
  snapshot_current: false,
  changes: input.changes.map((change, index) => ({
    key: change.key,
    action: change.action,
    revision: index + 7,
    epoch: 83,
    ...(change.action === 'clear' ? { cleared: true } : {}),
  })),
};
const resetReceipt: AdminConfigWriteResult = {
  committed_epoch: 84,
  snapshot_epoch: 79,
  snapshot_current: false,
  changes: resetInput.keys.map((key, index) => ({
    key,
    action: 'clear',
    revision: index + 8,
    epoch: 84,
    cleared: index !== 2,
  })),
};
const writer = vi.fn<AdminConfigWriter>();

function request(body: unknown, reset: boolean): Request {
  return new Request(`http://localhost/api/admin/config${reset ? '/reset' : ''}`, {
    method: reset ? 'POST' : 'PATCH',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetAdminConfigWriterForTests();
  writer.mockReset().mockResolvedValue(receipt);
});
afterEach(() => {
  __resetAdminConfigWriterForTests();
  vi.restoreAllMocks();
});

const invalidPatchInputs: { name: string; body: unknown }[] = [
  { name: 'null body', body: null },
  { name: 'array body', body: [] },
  { name: 'missing changes', body: { note: 'unchanged' } },
  { name: 'empty changes', body: { changes: [] } },
  {
    name: 'over 256 changes',
    body: { changes: Array.from({ length: 257 }, () => input.changes[0]) },
  },
  { name: 'non-array changes', body: { changes: {} } },
  { name: 'root actor', body: { ...input, actor: 'owner' } },
  { name: 'unknown action', body: { changes: [{ action: 'reset', key: 'locale.learner' }] } },
  { name: 'missing key', body: { changes: [{ action: 'clear' }] } },
  { name: 'empty key', body: { changes: [{ action: 'clear', key: '' }] } },
  {
    name: 'over 200 character key',
    body: { changes: [{ action: 'clear', key: 'k'.repeat(201) }] },
  },
  { name: 'non-string key', body: { changes: [{ action: 'clear', key: 1 }] } },
  { name: 'set missing value', body: { changes: [{ action: 'set', key: 'locale.learner' }] } },
  {
    name: 'set null value',
    body: { changes: [{ action: 'set', key: 'locale.learner', value: null }] },
  },
  {
    name: 'set non-string array',
    body: { changes: [{ action: 'set', key: 'locale.learner', value: [1] }] },
  },
  {
    name: 'set extra actor',
    body: { changes: [{ action: 'set', key: 'locale.learner', value: 'en', actor: 'owner' }] },
  },
  {
    name: 'clear with value',
    body: { changes: [{ action: 'clear', key: 'locale.learner', value: 'en' }] },
  },
  {
    name: 'clear extra property',
    body: { changes: [{ action: 'clear', key: 'locale.learner', note: 'nested' }] },
  },
  { name: 'over 2000 character note', body: { ...input, note: 'n'.repeat(2001) } },
  { name: 'null note', body: { ...input, note: null } },
  { name: 'numeric note', body: { ...input, note: 1 } },
];
const invalidResetInputs: { name: string; body: unknown }[] = [
  { name: 'null body', body: null },
  { name: 'array body', body: [] },
  { name: 'missing keys', body: { note: 'unchanged' } },
  { name: 'empty keys', body: { keys: [] } },
  { name: 'over 256 keys', body: { keys: Array.from({ length: 257 }, () => 'locale.learner') } },
  { name: 'non-array keys', body: { keys: 'locale.learner' } },
  { name: 'root actor', body: { ...resetInput, actor: 'owner' } },
  { name: 'root changes', body: { ...resetInput, changes: [] } },
  { name: 'empty key', body: { keys: [''] } },
  { name: 'over 200 character key', body: { keys: ['k'.repeat(201)] } },
  { name: 'non-string key', body: { keys: [1] } },
  { name: 'null key', body: { keys: [null] } },
  { name: 'over 2000 character note', body: { ...resetInput, note: 'n'.repeat(2001) } },
  { name: 'null note', body: { ...resetInput, note: null } },
  { name: 'numeric note', body: { ...resetInput, note: 1 } },
];

describe.each([false, true])(
  'public configuration operation and real HTTP adapter (reset=%s)',
  (reset) => {
    const operation = reset ? resetAdminConfig : patchAdminConfig;
    const handler = reset ? RESET : PATCH;
    const validInput = reset ? resetInput : input;
    const expectedReceipt = reset ? resetReceipt : receipt;
    const message = reset
      ? 'Expected keys and an optional note'
      : 'Expected changes and an optional note';
    const mutations = reset
      ? resetInput.keys.map((key) => ({ action: 'clear', key }))
      : input.changes;

    beforeEach(() => {
      writer.mockResolvedValue(expectedReceipt);
    });

    it.each(reset ? invalidResetInputs : invalidPatchInputs)(
      'rejects $name before writer availability or invocation',
      async ({ body }) => {
        for (const installed of [false, true]) {
          if (installed) setAdminConfigWriter(writer);
          await expect(operation(body)).rejects.toMatchObject({
            code: 'invalid_config_request',
            message,
            status: 400,
          });
          const response = await handler(request(body, reset));
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: 'invalid_config_request', message });
          expect(writer).not.toHaveBeenCalled();
        }
      },
    );

    it('only reports writer unavailable for valid input', async () => {
      await expect(operation(validInput)).rejects.toMatchObject({
        code: 'config_writer_unavailable',
        message: 'Configuration writer is unavailable',
        status: 503,
      });
      const response = await handler(request(validInput, reset));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'config_writer_unavailable',
        message: 'Configuration writer is unavailable',
      });
    });

    it.each(['{', '', 'not json', '{"note":'])(
      'keeps invalid JSON precedence without a writer: %s',
      async (body) => {
        const response = await handler(
          new Request('http://localhost/api/admin/config', { method: 'POST', body }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'invalid_json',
          message: 'Expected a JSON request body',
        });
        expect(writer).not.toHaveBeenCalled();
      },
    );

    it('forwards mutations and note once, retaining the complete noncurrent snapshot receipt', async () => {
      setAdminConfigWriter(writer);
      expect(await operation(validInput)).toBe(expectedReceipt);
      expect(writer.mock.calls).toEqual([[mutations, validInput.note]]);
      writer.mockClear();
      const response = await handler(request(validInput, reset));
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(AdminConfigWriteResponseSchema.parse(body)).toEqual(expectedReceipt);
      expect(body).toEqual(expectedReceipt);
      expect(writer.mock.calls).toEqual([[mutations, validInput.note]]);
    });

    it('reads the current injected writer on each invocation', async () => {
      setAdminConfigWriter(writer);
      await operation(validInput);
      const nextReceipt = { ...expectedReceipt, snapshot_epoch: 85, snapshot_current: true };
      const nextWriter = vi.fn<AdminConfigWriter>().mockResolvedValue(nextReceipt);
      setAdminConfigWriter(nextWriter);
      expect(await operation(validInput)).toBe(nextReceipt);
      expect(writer).toHaveBeenCalledTimes(1);
      expect(nextWriter.mock.calls).toEqual([[mutations, validInput.note]]);
    });

    it.each([
      new ApiError('invalid_config_value', 'Native provider/model pair is incompatible', 422, {
        'x-config-error': 'pair',
      }),
      new ApiError('config_read_only', 'Operator pin is read-only', 409),
      new Error('private DB connection detail'),
      'unknown non-Error failure',
    ])('preserves downstream errors without retrying: %s', async (error) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      writer.mockRejectedValue(error);
      setAdminConfigWriter(writer);
      await expect(operation(validInput)).rejects.toBe(error);
      expect(writer).toHaveBeenCalledTimes(1);
      writer.mockClear();
      const response = await handler(request(validInput, reset));
      expect(writer.mock.calls).toEqual([[mutations, validInput.note]]);
      if (error instanceof ApiError) {
        expect(response.status).toBe(error.status);
        expect(await response.json()).toEqual({ error: error.code, message: error.message });
        expect(response.headers.get('x-config-error')).toBe(
          new Headers(error.headers).get('x-config-error'),
        );
        expect(log).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: 'internal_error',
          message: 'Internal Server Error',
        });
        expect(log).toHaveBeenCalledTimes(1);
      }
    });
  },
);

describe('original schema semantics through the public port', () => {
  it('retains duplicate reset keys for the existing writer to reject, with one call', async () => {
    const body: AdminConfigResetInput = {
      keys: ['locale.learner', 'locale.learner'],
      note: input.note,
    };
    const error = new ApiError(
      'duplicate_config_key',
      "duplicate config key 'locale.learner'",
      400,
    );
    expect(AdminConfigResetBodySchema.parse(body)).toEqual(body);
    writer.mockRejectedValue(error);
    setAdminConfigWriter(writer);
    await expect(resetAdminConfig(body)).rejects.toBe(error);
    const mutations = body.keys.map((key) => ({ action: 'clear', key }));
    expect(writer.mock.calls).toEqual([[mutations, body.note]]);
    writer.mockClear();
    const response = await RESET(request(body, true));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: error.code, message: error.message });
    expect(writer.mock.calls).toEqual([[mutations, body.note]]);
  });

  it('accepts all value variants, key/note limits and 256 entries without coercion', async () => {
    setAdminConfigWriter(writer);
    const values = [
      true,
      false,
      0,
      3.5,
      '',
      '长文本\n'.repeat(1000),
      ['a', 'b'],
      { nested: [null, { value: 42 }] },
    ];
    const body: AdminConfigWriteInput = {
      changes: Array.from({ length: 256 }, (_, index) => ({
        action: 'set',
        key: `${index}`.padEnd(200, 'k'),
        value: values[index % values.length],
      })),
      note: 'n'.repeat(2000),
    };
    expect(AdminConfigWriteBodySchema.parse(body)).toEqual(body);
    await patchAdminConfig(body);
    expect(writer.mock.calls).toEqual([[body.changes, body.note]]);
    writer.mockClear();
    await PATCH(request(body, false));
    expect(writer.mock.calls).toEqual([[body.changes, body.note]]);
    writer.mockClear();
    const reset: AdminConfigResetInput = {
      keys: body.changes.map((change) => change.key),
      note: body.note,
    };
    await resetAdminConfig(reset);
    expect(writer.mock.calls).toEqual([
      [reset.keys.map((key) => ({ action: 'clear', key })), reset.note],
    ]);
    writer.mockClear();
    await RESET(request(reset, true));
    expect(writer.mock.calls).toEqual([
      [reset.keys.map((key) => ({ action: 'clear', key })), reset.note],
    ]);
  });

  it('preserves absent and empty notes without inventing metadata', async () => {
    setAdminConfigWriter(writer);
    await patchAdminConfig({ changes: [{ action: 'clear', key: 'locale.learner' }] });
    await resetAdminConfig({ keys: ['locale.learner'], note: '' });
    expect(writer.mock.calls).toEqual([
      [[{ action: 'clear', key: 'locale.learner' }], undefined],
      [[{ action: 'clear', key: 'locale.learner' }], ''],
    ]);
  });

  it.each([NaN, Infinity, undefined])(
    'rejects non-JSON top-level set value %s without invoking writer',
    async (value) => {
      setAdminConfigWriter(writer);
      await expect(
        patchAdminConfig({ changes: [{ action: 'set', key: 'AI_RATE_LIMIT_MAX', value }] }),
      ).rejects.toMatchObject({ code: 'invalid_config_request', status: 400 });
      expect(writer).not.toHaveBeenCalled();
    },
  );
});
