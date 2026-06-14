import { describe, expect, it, vi } from 'vitest';
import { createMem0Config, createMemoryClient } from './client';

// P1 (YUK-341)：LLM/embedder 全走 openai-compat（智谱 GLM + 阿里百炼），凭据经 config
// 传入，无 process.env 改写（旧 withXiaomiBaseUrl env-dance + YUK-232 mutex 已删）。
const env = {
  DATABASE_URL: 'postgres://loom:secret@127.0.0.1:5433/loom_test?sslmode=disable',
  ZHIPU_API_KEY: 'zhipu-key',
  DASHSCOPE_API_KEY: 'dashscope-key',
};

describe('createMem0Config', () => {
  it('maps project env to pgvector + 百炼 v4 embedder + GLM openai-compat LLM', () => {
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
        embeddingModelDims: 1024,
        hnsw: false,
        diskann: false,
      },
    });
    expect(config.embedder).toEqual({
      provider: 'openai', // openai-compat → 百炼 DashScope
      config: {
        apiKey: 'dashscope-key',
        model: 'text-embedding-v4',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        embeddingDims: 1024,
      },
    });
    expect(config.llm).toEqual({
      provider: 'openai', // openai-compat → 智谱 GLM coding plan 端点
      config: {
        apiKey: 'zhipu-key',
        model: 'glm-5.2',
        baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      },
    });
    // 调和层（P2）需 history；search() 已证 history-free，读端安全。
    expect(config.disableHistory).toBe(false);
    expect(config.historyDbPath).toBe('/var/lib/mem0/history.db');
  });

  it('embedder.embeddingDims 与 vectorStore.embeddingModelDims 同值（env 覆盖时一致）', () => {
    const config = createMem0Config({ ...env, MEM0_EMBEDDING_DIMS: '1536' });
    expect(config.vectorStore.config.embeddingModelDims).toBe(1536);
    // embedder config 的 embeddingDims 必须跟着同步（两字段名不同、同值，否则插入维度不匹配）。
    expect(config.embedder.config.embeddingDims).toBe(1536);
  });

  it('空串 MEM0_EMBEDDING_DIMS 回落默认 1024（bare `KEY=` 不能变 Number("")=0 打给 embedder）', () => {
    const config = createMem0Config({ ...env, MEM0_EMBEDDING_DIMS: '' });
    expect(config.vectorStore.config.embeddingModelDims).toBe(1024);
    expect(config.embedder.config.embeddingDims).toBe(1024);
    // 空串 override 也回落默认，非 ''（否则 model/baseURL 变空字符串打给 live API）。
    const llmCfg = createMem0Config({ ...env, MEM0_LLM_MODEL: '', MEM0_EMBEDDING_MODEL: '' });
    expect(llmCfg.llm.config.model).toBe('glm-5.2');
    expect(llmCfg.embedder.config.model).toBe('text-embedding-v4');
  });

  it('非法 MEM0_EMBEDDING_DIMS（非正整数）fail-fast', () => {
    expect(() => createMem0Config({ ...env, MEM0_EMBEDDING_DIMS: 'abc' })).toThrow(
      /MEM0_EMBEDDING_DIMS/,
    );
    expect(() => createMem0Config({ ...env, MEM0_EMBEDDING_DIMS: '0' })).toThrow(
      /MEM0_EMBEDDING_DIMS/,
    );
    expect(() => createMem0Config({ ...env, MEM0_EMBEDDING_DIMS: '-5' })).toThrow(
      /MEM0_EMBEDDING_DIMS/,
    );
  });

  it('model id / baseURL / history path 可经 env 覆盖（GLM 5.2 未 GA 时回退 glm-5）', () => {
    const config = createMem0Config({
      ...env,
      MEM0_LLM_MODEL: 'glm-5',
      MEM0_LLM_BASE_URL: 'https://api.z.ai/api/paas/v4',
      MEM0_HISTORY_DB_PATH: '/data/mem0/h.db',
    });
    expect(config.llm.config.model).toBe('glm-5');
    expect(config.llm.config.baseURL).toBe('https://api.z.ai/api/paas/v4');
    expect(config.historyDbPath).toBe('/data/mem0/h.db');
  });

  it('fails fast when required keys are missing', () => {
    expect(() => createMem0Config({ ...env, ZHIPU_API_KEY: '' })).toThrow(/ZHIPU_API_KEY/);
    expect(() => createMem0Config({ ...env, DASHSCOPE_API_KEY: '' })).toThrow(/DASHSCOPE_API_KEY/);
    expect(() => createMem0Config({ ...env, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});

describe('createMemoryClient', () => {
  it('forces the single-user Mem0 invariant on add/search', async () => {
    const memory = {
      add: vi.fn(async () => ({ results: [] })),
      search: vi.fn(async () => ({ results: [{ id: 'm1', memory: 'prefers terse feedback' }] })),
    };
    const client = createMemoryClient({ env, memoryFactory: () => memory });

    await client.addEventMemory({
      id: 'evt_1',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q1',
      payload: { user_response_md: 'A', referenced_knowledge_ids: ['k1'] },
      affected_scopes: ['global', 'topic:k1'],
      created_at: new Date('2026-05-27T00:00:00Z'),
      kind: 'event',
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
        created_ms: new Date('2026-05-27T00:00:00Z').getTime(),
        kind: 'event',
      },
      infer: true,
    });
    expect(memory.search).toHaveBeenCalledWith('what should I remember?', {
      topK: 3,
      filters: { affected_scopes: { contains: 'topic:k1' }, user_id: 'self' },
    });
  });

  it('凭据经 config 传入（GLM→llm / 百炼→embedder），不改写任何全局 env', () => {
    // openai-compat provider 转发 config.baseURL → 构造纯同步、无全局副作用。
    const hadAnthropicBaseUrl = Object.hasOwn(process.env, 'ANTHROPIC_BASE_URL');
    let seenConfig: ReturnType<typeof createMem0Config> | undefined;
    createMemoryClient({
      env,
      memoryFactory: (config) => {
        seenConfig = config;
        return { add: vi.fn(), search: vi.fn() };
      },
    });
    expect(seenConfig?.llm.config.apiKey).toBe('zhipu-key');
    expect(seenConfig?.embedder.config.apiKey).toBe('dashscope-key');
    expect(Object.hasOwn(process.env, 'ANTHROPIC_BASE_URL')).toBe(hadAnthropicBaseUrl);
  });

  it('不暴露 mem0 公开 update()（红线：update 替换式清 payload + textLemmatized）', () => {
    const client = createMemoryClient({
      env,
      memoryFactory: () => ({ add: vi.fn(), search: vi.fn() }),
    });
    expect('update' in client).toBe(false);
  });
});
