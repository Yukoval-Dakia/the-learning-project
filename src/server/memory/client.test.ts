import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMem0Config, createMemoryClient } from './client';

const env = {
  DATABASE_URL: 'postgres://loom:secret@127.0.0.1:5433/loom_test?sslmode=disable',
  OPENAI_API_KEY: 'openai-key',
  XIAOMI_API_KEY: 'xiaomi-key',
  ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
};

describe('createMem0Config', () => {
  it('maps project env to pgvector + OpenAI embedder + Anthropic/xiaomi LLM', () => {
    const config = createMem0Config(env);

    expect(config.vectorStore).toEqual({
      provider: 'pgvector',
      config: {
        collectionName: 'learning_project_memories',
        dbname: 'loom_test',
        user: 'loom',
        password: 'secret',
        host: '127.0.0.1',
        port: 5433,
        embeddingModelDims: 1536,
        hnsw: false,
        diskann: false,
      },
    });
    expect(config.embedder).toEqual({
      provider: 'openai',
      config: { apiKey: 'openai-key', model: 'text-embedding-3-small' },
    });
    expect(config.llm).toEqual({
      provider: 'anthropic',
      config: {
        apiKey: 'xiaomi-key',
        model: 'mimo-v2.5-pro',
      },
    });
  });

  it('fails fast when required keys are missing', () => {
    expect(() => createMem0Config({ ...env, OPENAI_API_KEY: '' })).toThrow(/OPENAI_API_KEY/);
    expect(() => createMem0Config({ ...env, XIAOMI_API_KEY: '' })).toThrow(/XIAOMI_API_KEY/);
    expect(() => createMem0Config({ ...env, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});

describe('createMemoryClient', () => {
  it('forces the single-user Mem0 invariant on add/search', async () => {
    const memory = {
      add: vi.fn(async () => ({ results: [] })),
      search: vi.fn(async () => ({ results: [{ id: 'm1', memory: 'prefers terse feedback' }] })),
    };

    const client = createMemoryClient({
      env,
      memoryFactory: () => memory,
    });

    await client.addEventMemory({
      id: 'evt_1',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q1',
      payload: { user_response_md: 'A', referenced_knowledge_ids: ['k1'] },
      affected_scopes: ['global', 'topic:k1'],
      created_at: new Date('2026-05-27T00:00:00Z'),
    });
    await client.search('what should I remember?', {
      topK: 3,
      filters: { user_id: 'other', scope_key: 'topic:k1' },
    });

    expect(memory.add).toHaveBeenCalledWith(expect.stringContaining('review'), {
      userId: 'self',
      metadata: {
        source: 'event',
        event_id: 'evt_1',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q1',
        affected_scopes: ['global', 'topic:k1'],
        created_at: '2026-05-27T00:00:00.000Z',
      },
      infer: true,
    });
    expect(memory.search).toHaveBeenCalledWith('what should I remember?', {
      topK: 3,
      filters: { affected_scopes: { contains: 'topic:k1' }, user_id: 'self' },
    });
  });

  it('passes the xiaomi key to the LLM via config, not via process.env', () => {
    let seenConfig: ReturnType<typeof createMem0Config> | undefined;
    createMemoryClient({
      env,
      memoryFactory: (config) => {
        seenConfig = config;
        return { add: vi.fn(), search: vi.fn() };
      },
    });
    expect(seenConfig?.llm.config.apiKey).toBe('xiaomi-key');
  });
});

describe('createMemoryClient process.env hygiene (YUK-140)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never assigns process.env.ANTHROPIC_API_KEY', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    createMemoryClient({
      env,
      memoryFactory: () => ({ add: vi.fn(), search: vi.fn() }),
    });
    // The xiaomi key must NOT have leaked into the global process env.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('sets ANTHROPIC_BASE_URL only during construction and restores it after', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    let baseUrlDuringConstruction: string | undefined;
    createMemoryClient({
      env,
      // The factory runs inside the scoped env window (same window that wraps
      // the real `new Memory`), so it observes the Xiaomi base URL...
      memoryFactory: () => {
        baseUrlDuringConstruction = process.env.ANTHROPIC_BASE_URL;
        return { add: vi.fn(), search: vi.fn() };
      },
    });
    expect(baseUrlDuringConstruction).toBe('https://api.xiaomimimo.com/anthropic');
    // ...but it must NOT persist afterward (restored to the pre-call undefined).
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('restores a pre-existing ANTHROPIC_BASE_URL value after construction', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://preexisting.example/anthropic');
    createMemoryClient({
      env,
      memoryFactory: () => ({ add: vi.fn(), search: vi.fn() }),
    });
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://preexisting.example/anthropic');
  });

  it('prefers MEM0_ANTHROPIC_BASE_URL over ANTHROPIC_BASE_URL for the scoped value', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    let seen: string | undefined;
    createMemoryClient({
      env: { ...env, MEM0_ANTHROPIC_BASE_URL: 'https://mem0-specific.example/anthropic' },
      memoryFactory: () => {
        seen = process.env.ANTHROPIC_BASE_URL;
        return { add: vi.fn(), search: vi.fn() };
      },
    });
    expect(seen).toBe('https://mem0-specific.example/anthropic');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe('createMemoryClient base-URL window mutex (YUK-232)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws if the construction window is re-entered (race guard)', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    // Simulate a `construct` callback that re-enters the scoped window before the
    // outer one has restored process.env — the exact overlap YUK-232 guards
    // against. The inner createMemoryClient must throw rather than corrupt the
    // shared process.env.ANTHROPIC_BASE_URL.
    expect(() =>
      createMemoryClient({
        env,
        memoryFactory: () => {
          createMemoryClient({
            env,
            memoryFactory: () => ({ add: vi.fn(), search: vi.fn() }),
          });
          return { add: vi.fn(), search: vi.fn() };
        },
      }),
    ).toThrow(/re-entrant ANTHROPIC_BASE_URL window/);
    // The global must be cleanly restored even though the inner call threw and
    // unwound through the outer finally.
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('releases the window lock after a normal construction so later calls succeed', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    // First construction takes and releases the lock.
    createMemoryClient({ env, memoryFactory: () => ({ add: vi.fn(), search: vi.fn() }) });
    // A second, sequential construction must not see a stuck lock.
    let baseUrlDuringSecond: string | undefined;
    expect(() =>
      createMemoryClient({
        env,
        memoryFactory: () => {
          baseUrlDuringSecond = process.env.ANTHROPIC_BASE_URL;
          return { add: vi.fn(), search: vi.fn() };
        },
      }),
    ).not.toThrow();
    expect(baseUrlDuringSecond).toBe('https://api.xiaomimimo.com/anthropic');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('releases the window lock even when construction throws', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    // A throwing factory must still unlock the window via the finally block,
    // otherwise every subsequent createMemoryClient would falsely report a race.
    expect(() =>
      createMemoryClient({
        env,
        memoryFactory: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow(/boom/);
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    // Lock is free again: a clean construction now succeeds.
    expect(() =>
      createMemoryClient({ env, memoryFactory: () => ({ add: vi.fn(), search: vi.fn() }) }),
    ).not.toThrow();
  });
});
