import { describe, expect, it, vi } from 'vitest';
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
});
