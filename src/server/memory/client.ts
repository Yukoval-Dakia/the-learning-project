import { randomUUID } from 'node:crypto';
import type { MemoryConfig, MemoryItem, SearchResult } from 'mem0ai/oss';
import { allowsDerivation } from '@/core/schema/derivation-policy';
import {
  type Mem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';
// Single source of truth for the mem0 pgvector collection name: backup and live
// client must resolve the same default so a restore lands on the table read here.
import { DASHSCOPE_EMBED_MODEL_ID } from '@/server/ai/providers';
import { MEM0_COLLECTION_DEFAULT } from '@/server/export/constants';
import { memoryLlmHeaders, resolveMemoryLlmConfig } from './llm-config';

export { memoryLlmHeaders, resolveMemoryLlmConfig } from './llm-config';

// The global product pin selects the extraction LLM; embeddings keep their own
// model and dimensions on the existing pgvector collection (ADR-0017).
const DEFAULT_COLLECTION = MEM0_COLLECTION_DEFAULT;
const DEFAULT_EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_EMBEDDING_DIMS = 1024; // embedder and vectorStore must agree
const DEFAULT_HISTORY_DB_PATH = '/var/lib/mem0/history.db'; // absolute; prod compose mounts it, dev overrides

export type Env = Record<string, string | undefined>;

/**
 * One mem0 SQLite memory_history tombstone. A DELETE carries the deleted text in
 * previous_value and is_deleted = 1: the backup undo face for pre-snapshot rows.
 */
export type MemoryHistoryEntry = {
  memory_id: string;
  previous_value: string | null;
  new_value: string | null;
  action: string;
  created_at: string | null;
  updated_at?: string | null;
  is_deleted: number;
};

export type Mem0Like = {
  add(
    messages: string,
    config: { userId: string; metadata: Record<string, unknown>; infer: boolean },
  ): Promise<SearchResult>;
  search(
    query: string,
    config: { topK?: number; filters?: Record<string, unknown> },
  ): Promise<SearchResult>;
  getAll(config: { topK?: number; filters: Record<string, unknown> }): Promise<SearchResult>;
  // Official delete writes a history tombstone before the vector DELETE.
  delete(memoryId: string): Promise<{ message: string }>;
  // Memory history rows back the undo face.
  history(memoryId: string): Promise<MemoryHistoryEntry[]>;
  // Returns null for an absent row instead of throwing; hardDelete uses it to
  // verify absence after a failed delete.
  get(memoryId: string): Promise<MemoryItem | null>;
};

export type MemoryEventInput = {
  id: string;
  /**
   * Extraction gate input: 'user' | 'agent'. Only user-originated events may be
   * extracted into mem0; agent output must never feed itself back (ADR-0039).
   */
  actor_kind: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
  affected_scopes: string[];
  created_at: Date;
  /**
   * Deterministic kind (preference / habit / weakness / event) stored in mem0
   * metadata and consumed by the reconcile prompt's per-kind rules.
   */
  kind: string;
};

export type MemoryClient = {
  findByEventId(eventId: string): Promise<MemoryEventResult>;
  addEventMemoryOnce(
    event: MemoryEventInput,
    providerOperation: Mem0OpaqueOperationContext,
    beforeProviderAdd: BeforeMemoryProviderAdd,
  ): Promise<{
    readonly result: MemoryEventResult;
    readonly resolution: 'provider_result' | 'event_lookup';
  }>;
  search(
    query: string,
    opts: { topK?: number; filters?: Record<string, unknown> },
    providerOperation: Mem0OpaqueOperationContext,
  ): Promise<SearchResult>;
  /**
   * Idempotent projection for canonical verbatim facts. The projection key is
   * stored in mem0 metadata and queried before add, so a retry after an add but
   * before process death returns the existing row instead of embedding twice.
   */
  addVerbatimOnce(
    text: string,
    metadata: Record<string, unknown>,
    projectionKey: string,
    providerOperation: Mem0OpaqueOperationContext,
    beforeProviderAdd: BeforeMemoryProviderAdd,
  ): Promise<SearchResult>;
  // Idempotent hard delete through official delete(), which tombstones first.
  hardDelete(memoryId: string): Promise<void>;
  // Undo face reads the DELETE tombstone.
  history(memoryId: string): Promise<MemoryHistoryEntry[]>;
  // Verbatim restore: infer:false stores the text as-is without re-running the
  // extraction LLM (which would paraphrase). Produces a new UUID.
  restoreVerbatim(
    text: string,
    metadata: Record<string, unknown>,
    providerOperation: Mem0OpaqueOperationContext,
  ): Promise<SearchResult>;
};

export type BeforeMemoryProviderAdd = () => Promise<void>;

export type MemoryEventResult = {
  readonly results: readonly { readonly id: string; readonly memory: string }[];
};

const EVENT_LOOKUP_COMPLETENESS_BOUND = 100;

export class Mem0EventLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mem0EventLookupError';
  }
}

function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Mem0 memory client requires ${name}`);
  return value;
}

// `??` would let a bare `KEY=` (loaded as '') become an empty model/baseURL/
// collection. Treat empty after trim as "use the default".
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
  const llm = resolveMemoryLlmConfig(env);
  const dashscopeApiKey = requireEnv(env, 'DASHSCOPE_API_KEY'); // Aliyun Bailian embedding
  const db = parseDatabaseUrl(databaseUrl);
  // embedder dimensions and vectorStore column dimensions must agree or inserts
  // fail. A bare `MEM0_EMBEDDING_DIMS=` must not become Number('') = 0 (that would
  // send dimensions:0 to the live embedder); empty after trim means default.
  const dimsRaw = env.MEM0_EMBEDDING_DIMS?.trim();
  const dims = dimsRaw ? Number(dimsRaw) : DEFAULT_EMBEDDING_DIMS;
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(
      `Mem0 MEM0_EMBEDDING_DIMS must be a positive integer (got ${JSON.stringify(env.MEM0_EMBEDDING_DIMS)})`,
    );
  }

  return {
    embedder: {
      provider: 'openai', // OpenAI-compatible adapter: baseURL points at DashScope
      config: {
        apiKey: dashscopeApiKey,
        model: optionalEnv(env, 'MEM0_EMBEDDING_MODEL', DASHSCOPE_EMBED_MODEL_ID),
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
      provider: 'openai', // Mem0 protocol adapter; llm-config selects the actual provider
      config: {
        apiKey: llm.apiKey,
        model: llm.model,
        baseURL: llm.baseURL,
        ...(llm.provider === 'opencode-go'
          ? {
              // Mem0 is opaque: one SDK client session, not an ai_task_run id.
              defaultHeaders: memoryLlmHeaders(llm, randomUUID()),
              maxRetries: 0,
              timeout: 60_000,
            }
          : {}),
      },
    },
    // History stays enabled because it makes the extraction prompt's "Last k
    // Messages" non-empty (only SQLiteManager implements it). Cost: the native
    // better-sqlite3 dependency. Reconciliation does not depend on it: that reads
    // its own Postgres WAL, and only add/update/delete write SQLite. App and worker
    // use separate historyDbPath values to avoid cross-container write contention.
    disableHistory: false,
    historyDbPath: optionalEnv(env, 'MEM0_HISTORY_DB_PATH', DEFAULT_HISTORY_DB_PATH),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEventMemoryResult(value: unknown, source: string): MemoryEventResult {
  if (!isJsonObject(value) || !Array.isArray(value.results)) {
    throw new Mem0EventLookupError(`${source} returned an unsupported response shape`);
  }
  const results = value.results.map((item, index) => {
    if (
      !isJsonObject(item) ||
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      typeof item.memory !== 'string'
    ) {
      throw new Mem0EventLookupError(`${source} returned an invalid result at index ${index}`);
    }
    return { id: item.id, memory: item.memory };
  });
  return { results };
}

function redactQuestionEvidenceForMemory(payload: unknown): unknown {
  if (!isJsonObject(payload) || !isJsonObject(payload.question_snapshot)) return payload;
  const snapshot = payload.question_snapshot;
  const redactReference = (context: unknown): unknown => {
    if (!isJsonObject(context)) return context;
    const { reference_md: _referenceMd, ...safeContext } = context;
    return safeContext;
  };
  return {
    ...payload,
    question_snapshot: {
      ...snapshot,
      question: redactReference(snapshot.question),
      parent_question: redactReference(snapshot.parent_question),
    },
  };
}

function eventToText(input: MemoryEventInput): string {
  return JSON.stringify({
    id: input.id,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    // Attempt snapshots contain gold references for later evidence replay. They
    // are system truth, not learner-authored facts, and must never enter Mem0's
    // infer:true extraction prompt.
    payload: redactQuestionEvidenceForMemory(input.payload),
  });
}

export function createMemoryClient(
  opts: { env?: Env; memoryFactory?: (config: MemoryConfig) => Mem0Like } = {},
): MemoryClient {
  const env = opts.env ?? process.env;
  // Credentials and baseURL travel entirely through config; no process.env rewrite.
  // Config is validated eagerly, the real SDK loads on first operation.
  const config = createMem0Config(env);
  const injectedMemory = opts.memoryFactory?.(config);
  let memoryPromise: Promise<Mem0Like> | undefined;
  const getMemory = (): Promise<Mem0Like> => {
    if (injectedMemory) return Promise.resolve(injectedMemory);
    memoryPromise ??= import('mem0ai/oss')
      .then(({ Memory }) => new Memory(config))
      .catch((error) => {
        memoryPromise = undefined;
        throw error;
      });
    return memoryPromise;
  };
  const findByEventId = async (eventId: string): Promise<MemoryEventResult> => {
    const memory = await getMemory();
    const result = parseEventMemoryResult(
      await memory.getAll({
        topK: EVENT_LOOKUP_COMPLETENESS_BOUND,
        filters: { user_id: 'self', event_id: eventId },
      }),
      'Mem0 getAll(event_id)',
    );
    if (result.results.length >= EVENT_LOOKUP_COMPLETENESS_BOUND) {
      throw new Mem0EventLookupError(
        `Mem0 getAll(event_id) exceeded completeness bound ${EVENT_LOOKUP_COMPLETENESS_BOUND}`,
      );
    }
    return result;
  };
  const addEventMemoryOnceAtBoundary = async (
    input: MemoryEventInput,
    providerOperation: Mem0OpaqueOperationContext,
    beforeProviderAdd: BeforeMemoryProviderAdd,
  ): Promise<SearchResult> => {
    const memory = await getMemory();
    const add = () =>
      memory.add(eventToText(input), {
        userId: 'self',
        metadata: {
          source: 'event',
          event_id: input.id,
          actor_kind: input.actor_kind,
          action: input.action,
          subject_kind: input.subject_kind,
          subject_id: input.subject_id,
          affected_scopes: input.affected_scopes,
          created_at: input.created_at.toISOString(),
          created_ms: input.created_at.getTime(),
          kind: input.kind,
        },
        infer: true,
      });
    return executeMem0OpaqueOperation(providerOperation, 'add_inferred', add, {
      providerStartFence: 'operation_kind',
      afterProviderStartReserved: beforeProviderAdd,
    });
  };

  return {
    findByEventId,
    async addEventMemoryOnce(input, providerOperation, beforeProviderAdd) {
      if (!allowsDerivation(input.payload))
        throw new Error('answer_only event cannot enter memory');
      const existing = await findByEventId(input.id);
      if (existing.results.length > 0) {
        return { result: existing, resolution: 'event_lookup' };
      }
      const added = await addEventMemoryOnceAtBoundary(input, providerOperation, beforeProviderAdd);
      return {
        result: parseEventMemoryResult(added, 'Mem0 add(event)'),
        resolution: 'provider_result',
      };
    },
    async addVerbatimOnce(text, metadata, projectionKey, providerOperation, beforeProviderAdd) {
      if (!allowsDerivation(metadata)) throw new Error('answer_only content cannot enter memory');
      const memory = await getMemory();
      const filters = { user_id: 'self', projection_key: projectionKey };
      const existing = await memory.getAll({ topK: 2, filters });
      if ((existing.results ?? []).length > 0) return existing;
      return executeMem0OpaqueOperation(
        providerOperation,
        'add_verbatim',
        () =>
          memory.add(text, {
            userId: 'self',
            metadata: { ...metadata, projection_key: projectionKey },
            infer: false,
          }),
        {
          providerStartFence: 'operation_kind',
          afterProviderStartReserved: beforeProviderAdd,
        },
      );
    },
    async search(query, searchOpts, providerOperation) {
      const memory = await getMemory();
      const { scope_key: scopeKey, ...filters } = searchOpts.filters ?? {};
      if (typeof scopeKey === 'string') {
        filters.affected_scopes ??= { contains: scopeKey };
      }
      filters.user_id = 'self';
      return executeMem0OpaqueOperation(providerOperation, 'search', () =>
        memory.search(query, { topK: searchOpts.topK, filters }),
      );
    },
    // Idempotent: a half-applied batch may replay. On any delete error, verify
    // absence via get() (null means absent). Absent → treat as success. Still
    // present, or the check itself fails → rethrow the original error. Do not
    // pattern-match messages: server errors like `role "x" does not exist` also
    // contain "does not exist" and would turn a failed delete into false success.
    // Only the error path pays for the extra get().
    async hardDelete(memoryId) {
      const memory = await getMemory();
      try {
        await memory.delete(memoryId);
      } catch (err) {
        let stillExists: boolean;
        try {
          stillExists = (await memory.get(memoryId)) !== null;
        } catch (verifyErr) {
          // The existence check failed, so absence is unconfirmed: surface the
          // original delete error.
          console.warn(
            `[memory] hardDelete: existence check (get) failed for ${memoryId}; surfacing original delete error`,
            verifyErr,
          );
          throw err; // cannot verify absence → surface the original delete error
        }
        if (stillExists) throw err; // row is still there → the delete truly failed
        // Row is gone: the failed delete was already applied (crash/replay). Log it
        // so an operator can distinguish a replay from a silent swallow.
        console.warn(
          `[memory] hardDelete: treating as idempotent success (row already absent) memoryId=${memoryId}`,
        );
      }
    },
    async history(memoryId) {
      return (await getMemory()).history(memoryId);
    },
    async restoreVerbatim(text, metadata, providerOperation) {
      if (!allowsDerivation(metadata)) throw new Error('answer_only content cannot enter memory');
      const memory = await getMemory();
      // infer:false skips the extraction LLM and inserts the raw text as one new
      // memory (new UUID, no MD5 dedup — dedup only exists on the infer:true path).
      // Never route undo through inferred extraction: it would paraphrase rather
      // than restore the original.
      return executeMem0OpaqueOperation(providerOperation, 'restore_verbatim', () =>
        memory.add(text, { userId: 'self', metadata, infer: false }),
      );
    },
  };
}
