import { Memory, type MemoryConfig, type SearchResult } from 'mem0ai/oss';

// P1 (YUK-341)：mem0 个性化半边换血到 GLM 5.2 + 百炼 v4，LLM/embedder 全走
// openai-compat provider——mem0ai 3.0.6 的 openai provider 转发 config.baseURL
// （anthropic 不转发，故弃 anthropic provider + 整套 withXiaomiBaseUrl env-dance）。
// 详见 docs/design/2026-06-13-memory-architecture.md §8.3。
const DEFAULT_COLLECTION = 'learning_project_memories';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v4'; // 阿里百炼 DashScope
const DEFAULT_EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; // 含 /v1
const DEFAULT_EMBEDDING_DIMS = 1024; // 百炼 v4 推荐性价比维度；embedder 与 vectorStore 必须同值
const DEFAULT_LLM_MODEL = 'glm-5.2'; // 智谱 GLM coding plan；可经 MEM0_LLM_MODEL 切 glm-5/glm-4.6
// coding plan 专用端点（owner 的 glm-5.2 access 在 coding plan）。**勿加 /v1**——
// 标准开放平台端点 /api/paas/v4 对 coding-plan 模型返 403，必须走 /api/coding/paas/v4。
// global 版是 https://api.z.ai/api/coding/paas/v4（经 MEM0_LLM_BASE_URL 切）。
const DEFAULT_LLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const DEFAULT_HISTORY_DB_PATH = '/var/lib/mem0/history.db'; // 绝对路径（默认相对 cwd 多进程踩坑）；prod compose 挂载卷，dev 经 MEM0_HISTORY_DB_PATH 覆盖

export type Env = Record<string, string | undefined>;

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
  /**
   * P2 (YUK-342): deterministic kind classification of the event action
   * (preference / habit / weakness / event). Fed into mem0 metadata flat-spread
   * as payload top-level `kind`, consumed by the reconcile LLM per-kind rules.
   * Set by triggers.ts:mapEventActionToKind (deterministic, not LLM).
   */
  kind: string;
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

// `??` only falls back on null/undefined — a bare `KEY=` in .env loads as ''
// (not unset), which would otherwise become an empty model/baseURL/collection
// string. Treat empty (after trim) as "use the default".
function optionalEnv(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
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
  const zhipuApiKey = requireEnv(env, 'ZHIPU_API_KEY'); // 智谱 GLM（openai-compat）
  const dashscopeApiKey = requireEnv(env, 'DASHSCOPE_API_KEY'); // 阿里百炼 embedding
  const db = parseDatabaseUrl(databaseUrl);
  // embedder.embeddingDims（把 dimensions 传百炼 v4）与 vectorStore.embeddingModelDims
  // （建 pgvector 列）必须同值，否则插入维度不匹配。空串（bare `MEM0_EMBEDDING_DIMS=`）
  // 不能落到 Number('')=0——那会把 dimensions:0 打给 live embedder。trim 后空 = 用默认。
  const dimsRaw = env.MEM0_EMBEDDING_DIMS?.trim();
  const dims = dimsRaw ? Number(dimsRaw) : DEFAULT_EMBEDDING_DIMS;
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(
      `Mem0 MEM0_EMBEDDING_DIMS must be a positive integer (got ${JSON.stringify(env.MEM0_EMBEDDING_DIMS)})`,
    );
  }

  return {
    embedder: {
      provider: 'openai', // openai-compat：转发 baseURL → 接百炼 DashScope
      config: {
        apiKey: dashscopeApiKey,
        model: optionalEnv(env, 'MEM0_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL),
        baseURL: optionalEnv(env, 'MEM0_EMBEDDING_BASE_URL', DEFAULT_EMBEDDING_BASE_URL),
        embeddingDims: dims,
      },
    },
    vectorStore: {
      provider: 'pgvector',
      config: {
        collectionName: optionalEnv(env, 'MEM0_PGVECTOR_COLLECTION', DEFAULT_COLLECTION),
        dbname: db.dbname,
        user: db.user,
        password: db.password,
        host: db.host,
        port: db.port,
        embeddingModelDims: dims,
        hnsw: env.MEM0_PGVECTOR_HNSW === 'true',
        diskann: env.MEM0_PGVECTOR_DISKANN === 'true',
      },
    },
    llm: {
      provider: 'openai', // openai-compat：转发 baseURL → 接智谱 GLM（弃 anthropic env-dance）
      config: {
        apiKey: zhipuApiKey,
        model: optionalEnv(env, 'MEM0_LLM_MODEL', DEFAULT_LLM_MODEL),
        baseURL: optionalEnv(env, 'MEM0_LLM_BASE_URL', DEFAULT_LLM_BASE_URL),
      },
    },
    // disableHistory:false（owner 拍板 2026-06-14，§3.1/§8.3）——唯一收益是让抽取
    // prompt 的 "Last k Messages" 非空（getLastMessages 只 SQLiteManager 有；dummy/
    // memory provider 都缺它 → 同样空）。代价：引入原生模块 better-sqlite3（Dockerfile
    // sqlitedeps overlay + esbuild --external）。**P2 调和层不依赖它**——调和读自建
    // Postgres memory_reconciliation_log（§3.5「mem0 history 只作辅助不作依赖」）。
    // search() 方法体零 history 写（只 add/update/delete 写 SQLite），写收敛 worker；
    // app(search) 与 worker(add) 各自独立 historyDbPath（compose 错开，避跨容器写锁竞争）。
    disableHistory: false,
    historyDbPath: optionalEnv(env, 'MEM0_HISTORY_DB_PATH', DEFAULT_HISTORY_DB_PATH),
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
  // P1 (YUK-341)：openai-compat provider 转发 config.baseURL（mem0ai 3.0.6 实证），
  // 凭据全经 config.{llm,embedder}.config.apiKey + baseURL，无需任何 process.env
  // 改写——构造纯同步、无全局副作用（旧 withXiaomiBaseUrl env-dance + YUK-232 mutex 已删）。
  const config = createMem0Config(env);
  const factory = opts.memoryFactory ?? ((c: MemoryConfig) => new Memory(c));
  const memory = factory(config);

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
          // P2 (YUK-342): created_ms (epoch milliseconds) for recency filtering;
          // kind for per-kind reconcile rules. Both flat-spread into mem0 payload
          // top-level by mem0's metadata handling.
          created_ms: input.created_at.getTime(),
          kind: input.kind,
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
