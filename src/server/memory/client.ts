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

// YUK-140 [M2]: avoid leaking Xiaomi creds into the global process.env.
//
// The xiaomi API key reaches mem0ai's Anthropic LLM cleanly via
// config.llm.config.apiKey (createMem0Config). The base URL is the one value we
// can't pass through config: the installed mem0ai AnthropicLLM constructs
// `new Anthropic({ apiKey })` WITHOUT forwarding config.baseURL, and the
// @anthropic-ai/sdk only adopts a custom base URL from the ANTHROPIC_BASE_URL
// env var when none is passed explicitly. mem0ai's `new Memory(config)` builds
// the LLM (and thus the Anthropic client) synchronously in its constructor, so
// we set ANTHROPIC_BASE_URL ONLY for the duration of that synchronous call and
// restore the prior value in finally — no persistent global mutation, and
// ANTHROPIC_API_KEY is never touched.
//
// Revisit if mem0ai gains baseURL forwarding for the Anthropic provider (it
// already does for openai/ollama/lmstudio/deepseek); then this can pass
// llm.config.baseURL directly and drop the env dance entirely.
function withXiaomiBaseUrl<T>(env: Env, construct: () => T): T {
  const baseUrl =
    env.MEM0_ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL;
  const had = Object.hasOwn(process.env, 'ANTHROPIC_BASE_URL');
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  try {
    return construct();
  } finally {
    // Restore exactly. If the var didn't exist before, remove it (not set to
    // the string "undefined"). Reflect.deleteProperty instead of `delete` to
    // satisfy Biome's noDelete lint while still truly clearing the key.
    if (had) process.env.ANTHROPIC_BASE_URL = prev;
    else Reflect.deleteProperty(process.env, 'ANTHROPIC_BASE_URL');
  }
}

export function createMemoryClient(
  opts: {
    env?: Env;
    memoryFactory?: (config: MemoryConfig) => Mem0Like;
  } = {},
): MemoryClient {
  const env = opts.env ?? process.env;
  // Validate the xiaomi key up front (also surfaces the failure with a clear
  // message). The key itself is threaded to mem0ai's Anthropic LLM via
  // config.llm.config.apiKey (createMem0Config) — NOT via env mutation.
  requireEnv(env, 'XIAOMI_API_KEY');

  const config = createMem0Config(env);
  // Scope ANTHROPIC_BASE_URL to ONLY the synchronous construction of the Memory
  // / LLM (mem0ai builds the Anthropic client in its constructor). The injected
  // test factory stands in for `new Memory` and runs inside the same scope, so
  // the restore-on-finally behaviour is exercised by tests too.
  const factory = opts.memoryFactory ?? ((c: MemoryConfig) => new Memory(c));
  const memory = withXiaomiBaseUrl(env, () => factory(config));

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
