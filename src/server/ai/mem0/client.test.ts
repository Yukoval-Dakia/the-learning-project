import { describe, expect, it, vi } from 'vitest';
import { createMem0OpaqueOperationContext } from '../provider-attempt-runtime';
import { createMemoryClient } from './client';

const sdk = vi.hoisted(() => ({
  loaded: vi.fn(),
  constructed: vi.fn(),
  getAll: vi.fn(async () => ({ results: [] })),
  history: vi.fn(async () => []),
}));

vi.mock('mem0ai/oss', () => {
  sdk.loaded();
  return {
    Memory: class {
      constructor() {
        sdk.constructed();
      }
      getAll = sdk.getAll;
      history = sdk.history;
    },
  };
});

// YUK-557 (F1/F7): file-local Mem0Like factory. Mem0Like is the INNER mem0 surface
// (add/search/delete/history/get) that createMemoryClient wraps — a DIFFERENT type
// from MemoryClient, so this stays file-local (NOT tests/helpers/memoryClientMock,
// which mocks the OUTER project surface). Every method is a no-op default with a
// spread override for whichever one a given test drives.

// P1 (YUK-341)：LLM/embedder 全走 openai-compat（智谱 GLM + 阿里百炼），凭据经 config
// 传入，无 process.env 改写（旧 withXiaomiBaseUrl env-dance + YUK-232 mutex 已删）。
const env = {
  DATABASE_URL: 'postgres://loom:secret@127.0.0.1:5433/loom_test?sslmode=disable',
  ZHIPU_API_KEY: 'zhipu-key',
  DASHSCOPE_API_KEY: 'dashscope-key',
};

function testProviderOperation() {
  return createMem0OpaqueOperationContext({
    caller: 'worker',
    deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
    operationAnchor: 'client-unit-operation-852',
    mode: 'observe',
    createLifecycle: (input) => ({
      identity: input.identity,
      acquire: async () => ({
        admission: 'acquired',
        reserveProviderStart: async () => {},
        recordExternalRequestId: async () => {},
        finish: async () => 'settled',
      }),
    }),
  });
}

describe('createMemoryClient', () => {
  // @invariant security: the memory client rejects restricted content before external processing
  // @fails-if restricted add or restore initializes the SDK or reaches the provider-start callback
  it('rejects answer-only inputs before SDK initialization, lookup, provider start or add', async () => {
    const before = sdk.loaded.mock.calls.length;
    const beforeAdd = vi.fn();
    const operation = testProviderOperation();
    const client = createMemoryClient({ env });
    await expect(
      client.addEventMemoryOnce(
        {
          id: 'restricted_ask',
          action: 'experimental:copilot_user_ask',
          actor_kind: 'user',
          subject_kind: 'query',
          subject_id: 'restricted_ask',
          kind: 'event',
          affected_scopes: [],
          payload: {
            derivation_policy: 'answer_only',
            user_message: '假设椭圆参数退化，尚未验证；不要进入长期判断。',
          },
          created_at: new Date(),
        },
        operation,
        beforeAdd,
      ),
    ).rejects.toThrow('cannot enter memory');
    await expect(
      client.addVerbatimOnce(
        '受限原文及多分支假设',
        { derivation_policy: 'answer_only' },
        'restricted_projection',
        operation,
        beforeAdd,
      ),
    ).rejects.toThrow('cannot enter memory');
    await expect(
      client.restoreVerbatim(
        '恢复不能重新引入受限原文',
        { derivation_policy: 'answer_only' },
        operation,
      ),
    ).rejects.toThrow('cannot enter memory');
    expect(sdk.loaded.mock.calls.length).toBe(before);
    expect(beforeAdd).not.toHaveBeenCalled();
  });
});
