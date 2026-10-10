import { type Mock, describe, expect, it, vi } from 'vitest';
import { createMem0OpaqueOperationContext } from '../ai/provider-attempt-runtime';
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
function mem0LikeMock(
  overrides: Partial<Record<'add' | 'search' | 'delete' | 'history' | 'get' | 'getAll', Mock>> = {},
) {
  return {
    add: vi.fn(async () => ({ results: [] })),
    search: vi.fn(async () => ({ results: [] })),
    delete: vi.fn(async () => ({ message: 'ok' })),
    history: vi.fn(async () => []),
    get: vi.fn(async () => null),
    getAll: vi.fn(async () => ({ results: [] })),
    ...overrides,
  };
}

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
  it('redacts child and parent gold references before inferred memory extraction', async () => {
    const memory = mem0LikeMock();
    const client = createMemoryClient({ env, memoryFactory: () => memory });

    await client.addEventMemoryOnce(
      {
        id: 'evt_attempt_snapshot',
        actor_kind: 'user',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q-child',
        payload: {
          answer_md: 'learner answer must remain',
          question_snapshot: {
            schema_version: 1,
            question: {
              question_id: 'q-child',
              prompt_md: 'child prompt remains',
              reference_md: 'CHILD GOLD MUST NOT LEAVE',
            },
            parent_question: {
              question_id: 'q-parent',
              prompt_md: 'parent prompt remains',
              reference_md: 'PARENT GOLD MUST NOT LEAVE',
            },
          },
        },
        affected_scopes: ['global'],
        created_at: new Date('2026-07-28T00:00:00Z'),
        kind: 'event',
      },
      testProviderOperation(),
      async () => {},
    );

    const serialized = memory.add.mock.calls[0]?.[0] as string;
    const extractionInput = JSON.parse(serialized) as {
      payload: {
        answer_md: string;
        question_snapshot: {
          question: Record<string, unknown>;
          parent_question: Record<string, unknown>;
        };
      };
    };
    expect(extractionInput.payload.answer_md).toBe('learner answer must remain');
    expect(extractionInput.payload.question_snapshot.question.prompt_md).toBe(
      'child prompt remains',
    );
    expect(extractionInput.payload.question_snapshot.parent_question.prompt_md).toBe(
      'parent prompt remains',
    );
    expect(extractionInput.payload.question_snapshot.question).not.toHaveProperty('reference_md');
    expect(extractionInput.payload.question_snapshot.parent_question).not.toHaveProperty(
      'reference_md',
    );
    expect(serialized).not.toContain('CHILD GOLD MUST NOT LEAVE');
    expect(serialized).not.toContain('PARENT GOLD MUST NOT LEAVE');
  });
});
