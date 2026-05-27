import { Memory, type MemoryConfig, type SearchResult } from 'mem0ai/oss';

const DEFAULT_COLLECTION = 'learning_project_memories';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_DIMS = 1536;
const DEFAULT_LLM_MODEL = 'mimo-v2.5-pro';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.xiaomimimo.com/anthropic';

type Env = Record<string, string | undefined>;

type Mem0Like = {
  add(
    messages: string,
    config: { userId: string; metadata: Record<string, unknown>; infer: boolean },
  ): Promise<SearchResult>;
  search(
    query: string,
    config: { topK?: number; filters?: Record<string, unknown> },
  ): Promise<SearchResult>;
};

export type MemoryEventInput = {
  id: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
  affected_scopes: string[];
  created_at: Date;
};

export type MemoryClient = {
  addEventMemory(event: MemoryEventInput): Promise<SearchResult>;
  search(
    query: string,
    opts?: { topK?: number; filters?: Record<string, unknown> },
  ): Promise<SearchResult>;
};

function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Mem0 memory client requires ${name}`);
  return value;
}

function parseDatabaseUrl(raw: string) {
  const url = new URL(raw);
  const dbname = url.pathname.replace(/^\//, '');
  if (!url.hostname || !dbname) {
    throw new Error('Mem0 memory client requires DATABASE_URL with host and database name');
  }
  return {
    dbname,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
  };
}

export function createMem0Config(env: Env = process.env): MemoryConfig {
  const databaseUrl = requireEnv(env, 'DATABASE_URL');
  const openaiApiKey = requireEnv(env, 'OPENAI_API_KEY');
  const xiaomiApiKey = requireEnv(env, 'XIAOMI_API_KEY');
  const db = parseDatabaseUrl(databaseUrl);

  return {
    embedder: {
      provider: 'openai',
      config: {
        apiKey: openaiApiKey,
        model: env.MEM0_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      },
    },
    vectorStore: {
      provider: 'pgvector',
      config: {
        collectionName: env.MEM0_PGVECTOR_COLLECTION ?? DEFAULT_COLLECTION,
        dbname: db.dbname,
        user: db.user,
        password: db.password,
        host: db.host,
        port: db.port,
        embeddingModelDims: Number(env.MEM0_EMBEDDING_DIMS ?? DEFAULT_EMBEDDING_DIMS),
        hnsw: env.MEM0_PGVECTOR_HNSW === 'true',
        diskann: env.MEM0_PGVECTOR_DISKANN === 'true',
      },
    },
    llm: {
      provider: 'anthropic',
      config: {
        apiKey: xiaomiApiKey,
        model: env.MEM0_LLM_MODEL ?? DEFAULT_LLM_MODEL,
      },
    },
    disableHistory: true,
  };
}

function eventToText(input: MemoryEventInput): string {
  return JSON.stringify({
    id: input.id,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    payload: input.payload,
  });
}

export function createMemoryClient(
  opts: {
    env?: Env;
    memoryFactory?: (config: MemoryConfig) => Mem0Like;
  } = {},
): MemoryClient {
  const env = opts.env ?? process.env;
  const xiaomiApiKey = requireEnv(env, 'XIAOMI_API_KEY');
  process.env.ANTHROPIC_BASE_URL =
    env.MEM0_ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = xiaomiApiKey;

  const config = createMem0Config(env);
  const memory = opts.memoryFactory ? opts.memoryFactory(config) : new Memory(config);

  return {
    async addEventMemory(input) {
      return memory.add(eventToText(input), {
        userId: 'self',
        metadata: {
          source: 'event',
          event_id: input.id,
          action: input.action,
          subject_kind: input.subject_kind,
          subject_id: input.subject_id,
          affected_scopes: input.affected_scopes,
          created_at: input.created_at.toISOString(),
        },
        infer: true,
      });
    },
    async search(query, searchOpts = {}) {
      const { scope_key: scopeKey, ...filters } = searchOpts.filters ?? {};
      if (typeof scopeKey === 'string') {
        filters.affected_scopes ??= { contains: scopeKey };
      }
      filters.user_id = 'self';
      return memory.search(query, { topK: searchOpts.topK, filters });
    },
  };
}
