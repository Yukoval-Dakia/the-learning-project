/* SIZE_OK: the source-backed lane registry is a data table with its co-located schema validator. */
export type ProviderLaneDisposition = 'migrate' | 'opaque' | 'prune' | 'exempt';

export type SourceEvidence = {
  readonly path: string;
  readonly imports?: readonly string[];
  readonly calls?: readonly string[];
  readonly envReads?: readonly string[];
  readonly literals?: readonly string[];
  readonly contains?: readonly string[];
};

export type ConfigurationTruth = {
  readonly summary: string;
  readonly source: SourceEvidence;
};

export type ProviderConfigurationTruth = {
  readonly endpoint: ConfigurationTruth;
  readonly credential: ConfigurationTruth;
  readonly model: ConfigurationTruth;
};

export type ProviderWireCall =
  | 'fetch'
  | 'fetchImpl'
  | 'client.messages.create'
  | 'memory.add'
  | 'memory.search'
  | 'client.DescribeQuestionMarkAgentJob'
  | 'client.SubmitQuestionMarkAgentJob';

export type WireEvidence = SourceEvidence & {
  readonly calls: readonly ProviderWireCall[];
};

export type DirectImporterKind = 'runtime' | 'type' | 're-export' | 'dynamic';

export type DirectImporter = {
  readonly path: string;
  readonly kind: DirectImporterKind;
};

export type ImportedFetchException = {
  readonly path: string;
  readonly source: string;
  readonly imported: 'fetch';
  readonly local: string;
  readonly owner: string;
  readonly purpose: string;
  readonly expectedCalls: 1;
  readonly directImporters: readonly {
    readonly path: string;
    readonly kind: DirectImporterKind;
    readonly source: string;
    readonly imported: string;
    readonly local: string;
  }[];
};

export type ProviderSdkRuntimeImport =
  | {
      readonly path: string;
      readonly source: string;
      readonly disposition: 'central';
      readonly imported: 'startup';
      readonly local: string;
    }
  | {
      readonly path: string;
      readonly source: string;
      readonly disposition: 'lane';
      readonly laneId: string;
    }
  | {
      readonly path: string;
      readonly source: string;
      readonly disposition: 'exempt';
      readonly laneId: string;
      readonly imported: 'default';
      readonly local: string;
    };

export type ProviderAttemptsPerInvocation =
  | {
      readonly kind: 'exact';
      readonly value: number;
      readonly fixedRequestCount: number;
      readonly fixedFanOutMultiplier: number;
    }
  | {
      readonly kind: 'dynamic';
      readonly multiplierRationale: string;
    };

export type ProviderAttemptSemantics = {
  readonly admittedUnit: string;
  readonly durableIdentity: string;
  readonly timeout: string;
  readonly clientRetry: string;
  readonly transportRetryCount: number;
  readonly attemptsPerInvocation: ProviderAttemptsPerInvocation;
  readonly redelivery: string;
  readonly fanOut: string;
  readonly evidence: readonly SourceEvidence[];
};

export type ProviderLaneExemption = {
  readonly owner: string;
  readonly reason: string;
  readonly expiresOn: string;
  readonly maxAttemptsPerInvocation: number;
  readonly timeoutMs: number;
  readonly clientRetryLimit: number;
  readonly evidence: SourceEvidence;
};

export type ProviderLane = {
  readonly id: string;
  readonly owner: string;
  readonly disposition: ProviderLaneDisposition;
  readonly wire: WireEvidence;
  readonly callers: readonly SourceEvidence[];
  readonly directImporters: readonly DirectImporter[];
  readonly roles: readonly ('api' | 'worker' | 'operator')[];
  readonly provider: string;
  readonly model: string;
  readonly endpointClass: string;
  readonly configuration: ProviderConfigurationTruth;
  readonly evidence: SourceEvidence;
  readonly attemptSemantics: ProviderAttemptSemantics;
  readonly exemption?: ProviderLaneExemption;
  readonly costSupport: string;
};

export type ProviderLaneCandidate = Omit<
  ProviderLane,
  'attemptSemantics' | 'disposition' | 'exemption'
> & {
  readonly disposition: string;
  readonly attemptSemantics?: Omit<
    ProviderAttemptSemantics,
    'attemptsPerInvocation' | 'transportRetryCount'
  > & {
    readonly attemptsPerInvocation?: ProviderAttemptsPerInvocation;
    readonly transportRetryCount?: number;
  };
  readonly exemption?: ProviderLaneExemption;
};

const prunedMisconceptionModules = [
  'src/capabilities/knowledge/server/misconception-reconcile.ts',
  'src/capabilities/knowledge/server/misconception-reconcile.unit.test.ts',
  'src/capabilities/knowledge/server/misconception-reconcile-store.ts',
  'src/capabilities/knowledge/server/misconception-reconcile-store.db.test.ts',
] as const;

export const PRUNED_MISCONCEPTION_MODULES = prunedMisconceptionModules;

export const IMPORTED_FETCH_EXCEPTIONS = [
  {
    path: 'src/capabilities/ingestion/server/pinned-fetch.ts',
    source: 'undici',
    imported: 'fetch',
    local: 'undiciFetch',
    owner: 'capabilities/ingestion',
    purpose: 'bounded content-download transport; not an AI/provider wire',
    expectedCalls: 1,
    directImporters: [
      {
        path: 'src/capabilities/ingestion/server/image-candidate-accept.ts',
        kind: 'runtime',
        source: '@/capabilities/ingestion/server/pinned-fetch',
        imported: 'fetchWithPinnedDispatcher',
        local: 'fetchWithPinnedDispatcher',
      },
    ],
  },
] as const satisfies readonly ImportedFetchException[];

export const PROVIDER_RUNTIME_SDK_IMPORTS = [
  {
    path: 'src/server/ai/runner.ts',
    source: '@anthropic-ai/claude-agent-sdk',
    disposition: 'central',
    imported: 'startup',
    local: 'sdkStartup',
  },
  {
    path: 'src/server/memory/client.ts',
    source: 'mem0ai/oss',
    disposition: 'lane',
    laneId: 'mem0.event-memory',
  },
  {
    path: 'src/capabilities/ingestion/server/tencent_mark.ts',
    source: 'tencentcloud-sdk-nodejs-ocr',
    disposition: 'lane',
    laneId: 'tencent.question-mark-agent',
  },
  {
    path: 'scripts/preflight-vision-one-shot.ts',
    source: '@anthropic-ai/sdk',
    disposition: 'exempt',
    laneId: 'xiaomi.vision-preflight',
    imported: 'default',
    local: 'Anthropic',
  },
] as const satisfies readonly ProviderSdkRuntimeImport[];

export const PROVIDER_LANES = [
  {
    id: 'dashscope.embedding',
    owner: 'server/ai',
    disposition: 'migrate',
    wire: {
      path: 'src/server/ai/embed.ts',
      calls: ['fetch'],
      contains: ['/embeddings'],
    },
    callers: [
      {
        path: 'src/capabilities/practice/jobs/embed_backfill.ts',
        imports: ['@/server/ai/embed'],
      },
      {
        path: 'src/server/quiz/matcher.ts',
        imports: ['@/server/ai/embed'],
      },
      {
        path: 'src/capabilities/knowledge/server/tag-knowledge.ts',
        imports: ['@/server/ai/embed'],
      },
      {
        path: 'src/capabilities/ingestion/server/auto-enroll.ts',
        imports: ['@/capabilities/knowledge/public'],
      },
      {
        path: 'src/capabilities/ingestion/server/image-candidate-accept.ts',
        imports: ['@/capabilities/knowledge/public'],
      },
    ],
    directImporters: [
      { path: 'src/capabilities/knowledge/server/tag-knowledge.ts', kind: 'runtime' },
      { path: 'src/capabilities/practice/jobs/embed_backfill.ts', kind: 'runtime' },
      { path: 'src/server/quiz/matcher.ts', kind: 'runtime' },
    ],
    roles: ['api', 'worker'],
    provider: 'DashScope OpenAI-compatible endpoint; MEM0_EMBEDDING_BASE_URL is env-configurable',
    model: 'text-embedding-v4 fixed in source',
    endpointClass: 'OpenAI-compatible embeddings POST /embeddings',
    configuration: {
      endpoint: {
        summary: 'MEM0_EMBEDDING_BASE_URL env override; defaults to DashScope compatible v1',
        source: {
          path: 'src/server/ai/embed.ts',
          envReads: ['MEM0_EMBEDDING_BASE_URL'],
          literals: ['https://dashscope.aliyuncs.com/compatible-mode/v1'],
        },
      },
      credential: {
        summary: 'DashScope API credential from DASHSCOPE_API_KEY',
        source: { path: 'src/server/ai/embed.ts', envReads: ['DASHSCOPE_API_KEY'] },
      },
      model: {
        summary: 'fixed text-embedding-v4 source literal',
        source: { path: 'src/server/ai/embed.ts', literals: ['text-embedding-v4'] },
      },
    },
    evidence: {
      path: 'src/server/ai/embed.ts',
      calls: ['executeDirectProviderAttempt', 'attempt.reportUsage'],
      contains: ['dashscope.embedding'],
    },
    attemptSemantics: {
      admittedUnit: 'one HTTP embedding chunk containing at most 10 input texts',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'dynamic',
        multiplierRationale:
          'embedMany emits ceil(input_count / 10) sequential requests; the fixed 200-row backfill cap yields 20 requests before pg-boss redelivery',
      },
      durableIdentity:
        'one provider_attempt per chunk; one operation identity spans the embedMany invocation',
      timeout: '15 seconds per chunk with AbortController cancellation',
      clientRetry: 'none; the fetch executes once per attempt wrapper invocation',
      redelivery:
        'API calls are not redelivered; llm worker jobs have retryLimit 2, so the 20-attempt backfill ceiling composes to at most 60 wire attempts per logical job',
      fanOut:
        'sequential ceil(input_count / 10) chunks per embedMany call; the nightly backfill reads at most 100 questions plus 100 knowledge rows, bounding one job at 20 wire attempts',
      evidence: [
        {
          path: 'src/server/ai/embed.ts',
          calls: ['executeDirectProviderAttempt', 'setTimeout'],
          contains: ['EMBED_MAX_BATCH = 10'],
        },
        {
          path: 'src/capabilities/practice/jobs/embed_backfill.ts',
          calls: ['runEmbedBackfill'],
          contains: ['operationAnchor: jobs[0]?.id', 'runEmbedBackfill(db, 100'],
        },
        {
          path: 'src/server/boss/queue-config.ts',
          imports: ['@/server/boss/client'],
          contains: ['JOB_RETRY_LIMIT = 2'],
        },
      ],
    },
    costSupport:
      'provider_attempt records reported token usage and preserves unknown monetary cost',
  },
  {
    id: 'glm.knowledge-edge-reconcile',
    owner: 'capabilities/knowledge',
    disposition: 'migrate',
    wire: {
      path: 'src/capabilities/knowledge/server/edge-reconcile.ts',
      calls: ['fetchImpl'],
      contains: ['judgeEdgeReconcile', '/chat/completions'],
    },
    callers: [
      {
        path: 'src/capabilities/knowledge/server/propose_edge.ts',
        imports: ['./edge-reconcile'],
      },
      {
        path: 'src/capabilities/knowledge/jobs/knowledge_edge_propose_nightly.ts',
        imports: ['@/capabilities/knowledge/server/propose_edge'],
      },
    ],
    directImporters: [
      { path: 'src/capabilities/knowledge/server/propose_edge.ts', kind: 'runtime' },
    ],
    roles: ['api', 'worker'],
    provider: 'GLM OpenAI-compatible endpoint via env-configurable Mem0 LLM configuration',
    model: 'env-resolved MEM0_LLM_MODEL through resolveGlmConfig',
    endpointClass: 'OpenAI-compatible chat completions POST /chat/completions',
    configuration: {
      endpoint: {
        summary: 'MEM0_LLM_BASE_URL env override; defaults to GLM coding-plan compatible endpoint',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['MEM0_LLM_BASE_URL'],
          literals: ['https://open.bigmodel.cn/api/coding/paas/v4'],
        },
      },
      credential: {
        summary: 'GLM credential from ZHIPU_API_KEY through createMem0Config',
        source: { path: 'src/server/memory/client.ts', envReads: ['ZHIPU_API_KEY'] },
      },
      model: {
        summary: 'MEM0_LLM_MODEL env override; defaults to glm-5.2',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['MEM0_LLM_MODEL'],
          literals: ['glm-5.2'],
        },
      },
    },
    evidence: {
      path: 'src/capabilities/knowledge/server/edge-reconcile.ts',
      calls: ['executeDirectProviderAttempt', 'attempt.estimateCost'],
    },
    attemptSemantics: {
      admittedUnit: 'one HTTP chat-completions request for one edge reconciliation judgment',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'dynamic',
        multiplierRationale:
          'a proposal with no neighbors emits zero requests; up to five proposed edges can each emit one reconciliation request',
      },
      durableIdentity:
        'one provider_attempt per judgment fetch under the caller-provided operation identity',
      timeout: '60 seconds by default with AbortController cancellation',
      clientRetry: 'none inside the HTTP client; retryable responses are surfaced to the owner',
      redelivery:
        'the llm worker queue has retryLimit 2, composing one request per delivery to at most three wire attempts; API callers have no redelivery',
      fanOut:
        'zero requests when a proposal has no neighbors; otherwise one request per proposal, with at most five proposals in the owning operation',
      evidence: [
        {
          path: 'src/capabilities/knowledge/server/edge-reconcile.ts',
          calls: ['executeDirectProviderAttempt', 'setTimeout'],
          contains: ['DEFAULT_TIMEOUT_MS'],
        },
        {
          path: 'src/capabilities/knowledge/server/propose_edge.ts',
          imports: ['./edge-reconcile'],
          contains: ["caller: 'worker'"],
        },
        {
          path: 'src/server/boss/queue-config.ts',
          imports: ['@/server/boss/client'],
          contains: ['JOB_RETRY_LIMIT = 2'],
        },
      ],
    },
    costSupport: 'provider_attempt records reported usage and estimated CNY cost per wire attempt',
  },
  {
    id: 'glm.knowledge-misconception-reconcile',
    owner: 'capabilities/knowledge',
    disposition: 'prune',
    wire: {
      path: 'src/capabilities/knowledge/server/misconception-reconcile.ts',
      calls: ['fetchImpl'],
      contains: ['judgeReconciliation', '/chat/completions'],
    },
    callers: [],
    directImporters: [],
    roles: [],
    provider: 'GLM historical implementation',
    model: 'historical only; not runtime truth',
    endpointClass: 'historical OpenAI-compatible chat completions',
    configuration: {
      endpoint: {
        summary: 'historical endpoint configuration; no live runtime',
        source: {
          path: 'src/capabilities/knowledge/server/misconception-reconcile.ts',
          calls: ['fetchImpl'],
        },
      },
      credential: {
        summary: 'historical credential configuration; no live runtime',
        source: {
          path: 'src/capabilities/knowledge/server/misconception-reconcile.ts',
          contains: ['ZHIPU_API_KEY'],
        },
      },
      model: {
        summary: 'historical model configuration; no live runtime',
        source: {
          path: 'src/capabilities/knowledge/server/misconception-reconcile.ts',
          contains: ['model'],
        },
      },
    },
    evidence: {
      path: 'src/db/schema.ts',
      contains: ['misconception_reconciliation_log'],
    },
    attemptSemantics: {
      admittedUnit: 'none; the unreachable provider implementation was pruned',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'exact',
        value: 0,
        fixedRequestCount: 0,
        fixedFanOutMultiplier: 1,
      },
      durableIdentity: 'none; historical schema remains read-compatible without a runtime writer',
      timeout: 'not applicable after pruning',
      clientRetry: 'not applicable after pruning',
      redelivery: 'not applicable after pruning',
      fanOut: 'zero live attempts',
      evidence: [
        {
          path: 'src/db/schema.ts',
          calls: ['pgTable'],
          contains: ['misconception_reconciliation_log'],
        },
      ],
    },
    costSupport: 'not applicable after pruning; schema and migrations remain historical record',
  },
  {
    id: 'glm.memory-reconcile',
    owner: 'server/memory',
    disposition: 'migrate',
    wire: {
      path: 'src/server/memory/reconcile-llm.ts',
      calls: ['fetchImpl'],
      contains: ['judgeReconciliation', '/chat/completions'],
    },
    callers: [
      {
        path: 'src/server/memory/triggers.ts',
        imports: ['./reconcile-llm'],
      },
    ],
    directImporters: [{ path: 'src/server/memory/triggers.ts', kind: 'runtime' }],
    roles: ['worker'],
    provider: 'GLM OpenAI-compatible endpoint via env-configurable Mem0 LLM configuration',
    model: 'env-resolved MEM0_LLM_MODEL; hardcoded ledger text is not model truth',
    endpointClass: 'OpenAI-compatible chat completions POST /chat/completions',
    configuration: {
      endpoint: {
        summary: 'MEM0_LLM_BASE_URL env override; defaults to GLM coding-plan compatible endpoint',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['MEM0_LLM_BASE_URL'],
          literals: ['https://open.bigmodel.cn/api/coding/paas/v4'],
        },
      },
      credential: {
        summary: 'GLM credential from ZHIPU_API_KEY through createMem0Config',
        source: { path: 'src/server/memory/client.ts', envReads: ['ZHIPU_API_KEY'] },
      },
      model: {
        summary: 'MEM0_LLM_MODEL env override; defaults to glm-5.2',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['MEM0_LLM_MODEL'],
          literals: ['glm-5.2'],
        },
      },
    },
    evidence: {
      path: 'src/server/memory/reconcile-llm.ts',
      calls: ['executeDirectProviderAttempt', 'attempt.estimateCost'],
    },
    attemptSemantics: {
      admittedUnit: 'one HTTP chat-completions request for one memory reconciliation batch',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'exact',
        value: 1,
        fixedRequestCount: 1,
        fixedFanOutMultiplier: 1,
      },
      durableIdentity:
        'one provider_attempt per GLM fetch under the pg-boss job operation identity',
      timeout: '60 seconds by default, bounded again by the 65-second caller deadline',
      clientRetry: 'none inside the HTTP client; retryable failures propagate',
      redelivery:
        'the deterministic memory_reconcile job has retryLimit 3, composing one GLM request per delivery to at most four wire attempts',
      fanOut:
        'one GLM judgment after bounded sequential Mem0 searches for the memories in the job batch',
      evidence: [
        {
          path: 'src/server/memory/reconcile-llm.ts',
          calls: ['executeDirectProviderAttempt', 'setTimeout'],
          contains: ['DEFAULT_TIMEOUT_MS'],
        },
        {
          path: 'src/server/memory/triggers.ts',
          imports: ['./reconcile-llm'],
          contains: ['operationAnchor: job.id', 'new Date(Date.now() + 65_000)'],
        },
        {
          path: 'src/server/memory/memory-reconcile-handoff.ts',
          imports: ['@/db/client'],
          contains: ['retryLimit: 3', 'id: jobId'],
        },
      ],
    },
    costSupport: 'provider_attempt records reported usage and estimated CNY cost per wire attempt',
  },
  {
    id: 'glm.ocr-layout-parsing',
    owner: 'capabilities/ingestion',
    disposition: 'migrate',
    wire: {
      path: 'src/capabilities/ingestion/server/glm_ocr.ts',
      calls: ['fetch'],
      contains: ['runGlmLayoutParsing', 'layout_parsing'],
    },
    callers: [
      {
        path: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts',
        imports: ['@/capabilities/ingestion/server/glm_ocr'],
      },
    ],
    directImporters: [
      { path: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts', kind: 'runtime' },
      { path: 'src/capabilities/ingestion/server/glm_ocr_parser.ts', kind: 'type' },
    ],
    roles: ['worker'],
    provider: 'GLM OCR fixed HTTP endpoint',
    model: 'glm-ocr fixed in source',
    endpointClass: 'GLM layout_parsing POST endpoint',
    configuration: {
      endpoint: {
        summary: 'fixed GLM layout_parsing endpoint literal',
        source: {
          path: 'src/capabilities/ingestion/server/glm_ocr.ts',
          literals: ['https://open.bigmodel.cn/api/paas/v4/layout_parsing'],
        },
      },
      credential: {
        summary: 'GLM OCR credential from ZHIPU_API_KEY',
        source: {
          path: 'src/capabilities/ingestion/server/glm_ocr.ts',
          envReads: ['ZHIPU_API_KEY'],
        },
      },
      model: {
        summary: 'fixed glm-ocr model literal',
        source: { path: 'src/capabilities/ingestion/server/glm_ocr.ts', literals: ['glm-ocr'] },
      },
    },
    evidence: {
      path: 'src/capabilities/ingestion/server/glm_ocr.ts',
      calls: ['executeGlmOcrWireAttempt'],
      contains: ['recordExternalRequestId', 'reportUsage', 'estimateCost'],
    },
    attemptSemantics: {
      admittedUnit: 'one synchronous GLM layout_parsing request for one extraction page',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'dynamic',
        multiplierRationale:
          'the extraction delivery emits one request per page for a runtime page count capped at 15; pg-boss redelivery is accounted separately',
      },
      durableIdentity:
        'one provider_attempt per page fetch under a stable session-and-page operation identity',
      timeout: '120 seconds per page with caller abort composed into the same controller',
      clientRetry: 'none inside the HTTP client; retryable failures propagate',
      redelivery:
        'the llm worker queue has retryLimit 2; stable page anchors preserve the operation while each actual page retry is a new attempt',
      fanOut:
        'one sequential request per page, capped at 15 pages and three deliveries for a 45-attempt upper envelope',
      evidence: [
        {
          path: 'src/capabilities/ingestion/server/glm_ocr.ts',
          calls: ['fetch', 'setTimeout'],
          contains: ['DEFAULT_TIMEOUT_MS = 120_000'],
        },
        {
          path: 'src/capabilities/ingestion/server/provider-attempts.ts',
          calls: ['executeDirectProviderAttempt'],
          contains: ['operationAnchor: pageOperationId'],
        },
        {
          path: 'src/capabilities/ingestion/api/contracts.ts',
          imports: ['@/kernel/capability-contract-schemas'],
          contains: ['max(MAX_PDF_PAGES)'],
        },
        {
          path: 'src/server/boss/queue-config.ts',
          imports: ['@/server/boss/client'],
          contains: ['JOB_RETRY_LIMIT = 2'],
        },
      ],
    },
    costSupport:
      'each page fetch records provider request id, reported usage, and estimated CNY cost in provider_attempt',
  },
  {
    id: 'mem0.event-memory',
    owner: 'server/memory',
    disposition: 'opaque',
    wire: {
      path: 'src/server/memory/client.ts',
      calls: ['memory.add', 'memory.add', 'memory.add', 'memory.search'],
    },
    callers: [
      {
        path: 'src/server/memory/triggers.ts',
        calls: ['client.addEventMemoryOnce', 'client.addVerbatimOnce'],
      },
      {
        path: 'src/server/memory/triggers.ts',
        imports: ['./search-memories'],
      },
      {
        path: 'src/server/memory/read.ts',
        imports: ['./client', './search-memories'],
      },
    ],
    directImporters: [
      { path: 'src/capabilities/knowledge/server/edge-reconcile.ts', kind: 'runtime' },
      { path: 'src/capabilities/knowledge/server/propose_edge.ts', kind: 'type' },
      { path: 'src/server/memory/read.ts', kind: 'runtime' },
      { path: 'src/server/memory/reconcile-llm.ts', kind: 'runtime' },
      { path: 'src/server/memory/reconcile-store.ts', kind: 'type' },
      { path: 'src/server/memory/search-memories.ts', kind: 'type' },
      { path: 'src/server/memory/triggers.ts', kind: 'runtime' },
    ],
    roles: ['api', 'worker'],
    provider: 'Mem0 OSS with env-configurable OpenAI-compatible GLM and DashScope endpoints',
    model: 'opaque model-bearing memory.add and memory.search operations',
    endpointClass: 'Mem0 SDK add/search, including infer:false embedding writes',
    configuration: {
      endpoint: {
        summary:
          'MEM0_LLM_BASE_URL and MEM0_EMBEDDING_BASE_URL env overrides with GLM and DashScope defaults',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['MEM0_LLM_BASE_URL', 'MEM0_EMBEDDING_BASE_URL'],
          literals: [
            'https://open.bigmodel.cn/api/coding/paas/v4',
            'https://dashscope.aliyuncs.com/compatible-mode/v1',
          ],
        },
      },
      credential: {
        summary: 'Mem0 delegated credentials from ZHIPU_API_KEY and DASHSCOPE_API_KEY',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['ZHIPU_API_KEY', 'DASHSCOPE_API_KEY'],
        },
      },
      model: {
        summary:
          'MEM0_LLM_MODEL and MEM0_EMBEDDING_MODEL env overrides with GLM and DashScope defaults',
        source: {
          path: 'src/server/memory/client.ts',
          envReads: ['MEM0_LLM_MODEL', 'MEM0_EMBEDDING_MODEL'],
          literals: ['glm-5.2', 'text-embedding-v4'],
        },
      },
    },
    evidence: {
      path: 'src/server/memory/client.ts',
      calls: ['memory.add', 'memory.search'],
      contains: ['infer: false'],
    },
    attemptSemantics: {
      admittedUnit:
        'one opaque Mem0 SDK add or search operation, never represented as a known wire count',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'dynamic',
        multiplierRationale:
          'one opaque SDK attempt is recorded for each add or search boundary, while reconcile memory count and Mem0-internal provider fan-out are intentionally unbounded or unknown',
      },
      durableIdentity:
        'one provider_attempt opaque_operation row per SDK boundary invocation with stable owner operation identity',
      timeout: '65-second caller deadline; Mem0 internal request timing remains opaque',
      clientRetry:
        'Mem0 internal retry behavior is opaque and is not multiplied by a wrapper retry',
      redelivery:
        'worker redelivery reuses durable event/job anchors; reconcile retryLimit 3 composes to at most four observed SDK operations per input, while fenced start reservation prevents an ambiguous paid add from repeating',
      fanOut:
        'one opaque search is recorded per new memory before one GLM batch judgment; Mem0 internal GLM/DashScope fan-out stays explicitly unknown rather than guessed',
      evidence: [
        {
          path: 'src/server/memory/client.ts',
          calls: ['memory.add', 'memory.search'],
        },
        {
          path: 'src/server/ai/opaque-provider-operation.ts',
          calls: ['handle.reserveProviderStart', 'settleMem0OpaqueOperation'],
          contains: ['wireCount: null'],
        },
        {
          path: 'src/server/memory/memory-reconcile-handoff.ts',
          imports: ['@/db/client'],
          contains: ['retryLimit: 3', 'id: jobId'],
        },
      ],
    },
    costSupport: 'provider_attempt records each opaque Mem0 operation with unknown usage and cost',
  },
  {
    id: 'tencent.question-mark-agent',
    owner: 'capabilities/ingestion',
    disposition: 'migrate',
    wire: {
      path: 'src/capabilities/ingestion/server/tencent_mark.ts',
      calls: ['client.SubmitQuestionMarkAgentJob', 'client.DescribeQuestionMarkAgentJob'],
      contains: ['submitOcrJob', 'pollUntilDone'],
    },
    callers: [
      {
        path: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts',
        imports: ['@/capabilities/ingestion/server/tencent_mark'],
      },
    ],
    directImporters: [
      { path: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts', kind: 'runtime' },
    ],
    roles: ['worker'],
    provider: 'Tencent Cloud OCR SDK fixed endpoint',
    model: 'provider-managed QuestionMarkAgent',
    endpointClass: 'Tencent SDK SubmitQuestionMarkAgentJob and DescribeQuestionMarkAgentJob',
    configuration: {
      endpoint: {
        summary: 'Tencent OCR SDK endpoint literal',
        source: {
          path: 'src/capabilities/ingestion/server/tencent_mark.ts',
          literals: ['ocr.tencentcloudapi.com'],
        },
      },
      credential: {
        summary: 'Tencent SDK credentials from TENCENT_SECRET_ID and TENCENT_SECRET_KEY',
        source: {
          path: 'src/capabilities/ingestion/server/tencent_mark.ts',
          envReads: ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'],
        },
      },
      model: {
        summary: 'provider-managed QuestionMarkAgent model selected by SDK operations',
        source: {
          path: 'src/capabilities/ingestion/server/tencent_mark.ts',
          calls: ['client.SubmitQuestionMarkAgentJob', 'client.DescribeQuestionMarkAgentJob'],
        },
      },
    },
    evidence: {
      path: 'src/capabilities/ingestion/server/provider-attempts.ts',
      calls: ['executeDirectProviderAttempt'],
      contains: ['tencent.question-mark-agent'],
    },
    attemptSemantics: {
      admittedUnit:
        'one Tencent SubmitQuestionMarkAgentJob or DescribeQuestionMarkAgentJob SDK request',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'dynamic',
        multiplierRationale:
          'each page has one saved submit plus a runtime poll count capped at 150 per delivery; page count is capped at 15 and redelivery is accounted separately',
      },
      durableIdentity:
        'submit and polls are distinct provider_attempt rows sharing one page operation; JobId is durable external correlation',
      timeout: 'poll loop is bounded to 300 seconds with a 2-second interval by default',
      clientRetry:
        'the SDK call wrapper does not add a retry; each Describe is an explicit attempt',
      redelivery:
        'the llm worker queue has retryLimit 2; redelivery resumes the saved JobId and must not resubmit, while local poll timeout remains resumable',
      fanOut:
        'one saved submit per page followed by at most 150 sequential Describe attempts per delivery; 15 pages and three deliveries form a loose upper envelope of 15 submits plus 6750 describes',
      evidence: [
        {
          path: 'src/capabilities/ingestion/server/tencent_mark.ts',
          calls: ['client.SubmitQuestionMarkAgentJob', 'client.DescribeQuestionMarkAgentJob'],
          contains: ['timeoutMs ?? 300_000', 'intervalMs ?? 2000'],
        },
        {
          path: 'src/capabilities/ingestion/server/provider-attempts.ts',
          calls: ['executeDirectProviderAttempt'],
          contains: ['recordExternalRequestId'],
        },
        {
          path: 'src/capabilities/ingestion/api/contracts.ts',
          imports: ['@/kernel/capability-contract-schemas'],
          contains: ['max(MAX_PDF_PAGES)'],
        },
        {
          path: 'src/server/boss/queue-config.ts',
          imports: ['@/server/boss/client'],
          contains: ['JOB_RETRY_LIMIT = 2'],
        },
      ],
    },
    costSupport:
      'each Submit/Describe attempt records unknown usage and cost in provider_attempt without fabricating zero',
  },
  {
    id: 'xiaomi.vision-preflight',
    owner: 'scripts/preflight-vision',
    disposition: 'exempt',
    wire: {
      path: 'scripts/preflight-vision-one-shot.ts',
      calls: ['client.messages.create'],
      contains: ['maxRetries: 0', 'timeout: 30_000'],
    },
    callers: [{ path: 'scripts/preflight-vision.ts', calls: ['preflightVisionOneShot'] }],
    directImporters: [],
    roles: ['operator'],
    provider: 'Xiaomi MiMo through the Anthropic-compatible Messages SDK',
    model: 'CLI or MIMO_VISION_MODEL override; defaults to mimo-v2.5',
    endpointClass: 'manual Anthropic-compatible vision preflight',
    configuration: {
      endpoint: {
        summary: 'MIMO_VISION_BASE_URL override with Xiaomi Anthropic-compatible default',
        source: {
          path: 'scripts/preflight-vision.ts',
          envReads: ['MIMO_VISION_BASE_URL'],
          literals: ['https://api.xiaomimimo.com/anthropic'],
        },
      },
      credential: {
        summary: 'operator credential from XIAOMI_API_KEY',
        source: { path: 'scripts/preflight-vision.ts', envReads: ['XIAOMI_API_KEY'] },
      },
      model: {
        summary: 'CLI or MIMO_VISION_MODEL override with mimo-v2.5 default',
        source: {
          path: 'scripts/preflight-vision.ts',
          envReads: ['MIMO_VISION_MODEL'],
          literals: ['mimo-v2.5'],
        },
      },
    },
    evidence: {
      path: 'scripts/preflight-vision-one-shot.ts',
      imports: ['@anthropic-ai/sdk'],
      calls: ['client.messages.create'],
      contains: ['maxRetries: 0', 'timeout: 30_000'],
    },
    attemptSemantics: {
      admittedUnit: 'one manually invoked vision preflight Messages request',
      transportRetryCount: 0,
      attemptsPerInvocation: {
        kind: 'exact',
        value: 1,
        fixedRequestCount: 1,
        fixedFanOutMultiplier: 1,
      },
      durableIdentity: 'no provider_attempt row under the bounded operator-only exemption',
      timeout: '30 seconds per invocation',
      clientRetry: 'zero SDK retries',
      redelivery: 'none; the script is not a pg-boss consumer',
      fanOut: 'exactly one Messages request per CLI invocation',
      evidence: [
        {
          path: 'scripts/preflight-vision.ts',
          imports: ['./preflight-vision-one-shot'],
          calls: ['preflightVisionOneShot'],
        },
      ],
    },
    exemption: {
      owner: 'server/ai',
      reason:
        'manual support-only capability probe has no product caller and writes a dated response artifact',
      expiresOn: '2026-12-31',
      maxAttemptsPerInvocation: 1,
      timeoutMs: 30_000,
      clientRetryLimit: 0,
      evidence: {
        path: 'scripts/preflight-vision-one-shot.ts',
        imports: ['@anthropic-ai/sdk'],
        calls: ['client.messages.create'],
        contains: ['maxRetries: 0', 'timeout: 30_000'],
      },
    },
    costSupport:
      'no durable cost row under the explicit support exemption; the dated artifact preserves model, endpoint, duration, outcome, and raw response',
  },
] as const satisfies readonly ProviderLane[];

function missingEvidence(value: SourceEvidence): boolean {
  return (
    value.path.trim().length === 0 ||
    ![value.imports, value.calls, value.envReads, value.literals, value.contains].some(
      (items) => (items?.length ?? 0) > 0,
    ) ||
    [value.imports, value.calls, value.envReads, value.literals, value.contains].some((items) =>
      items?.some((item) => item.trim().length === 0),
    )
  );
}

function missingConfiguration(value: ConfigurationTruth): boolean {
  return value.summary.trim().length === 0 || missingEvidence(value.source);
}

function missingAttemptSemantics(value: ProviderLaneCandidate['attemptSemantics']): boolean {
  return (
    value === undefined ||
    [
      value.admittedUnit,
      value.durableIdentity,
      value.timeout,
      value.clientRetry,
      value.redelivery,
      value.fanOut,
    ].some((field) => field.trim().length === 0) ||
    value.evidence.length === 0 ||
    value.evidence.some((evidence) => missingEvidence(evidence) || lacksAstEvidence(evidence))
  );
}

function attemptCardinalityProblems(
  label: string,
  value: ProviderLaneCandidate['attemptSemantics'],
): string[] {
  if (!value?.attemptsPerInvocation) {
    return [`${label}: missing required attempt cardinality`];
  }
  const transportRetryCount = value.transportRetryCount;
  if (
    transportRetryCount === undefined ||
    !Number.isInteger(transportRetryCount) ||
    transportRetryCount < 0
  ) {
    return [`${label}: invalid transport retry count`];
  }
  const cardinality = value.attemptsPerInvocation;
  if (cardinality.kind === 'dynamic') {
    return cardinality.multiplierRationale.trim().length === 0
      ? [`${label}: dynamic attemptsPerInvocation requires multiplier rationale`]
      : [];
  }
  if (
    !Number.isInteger(cardinality.value) ||
    cardinality.value < 0 ||
    !Number.isInteger(cardinality.fixedRequestCount) ||
    cardinality.fixedRequestCount < 0 ||
    !Number.isInteger(cardinality.fixedFanOutMultiplier) ||
    cardinality.fixedFanOutMultiplier < 1
  ) {
    return [`${label}: invalid exact attemptsPerInvocation arithmetic`];
  }
  const calculated =
    cardinality.fixedRequestCount * cardinality.fixedFanOutMultiplier * (1 + transportRetryCount);
  return cardinality.value === calculated
    ? []
    : [
        `${label}: inconsistent attemptsPerInvocation: declared ${cardinality.value}, calculated ${calculated}`,
      ];
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function missingExemption(value: ProviderLaneExemption | undefined): boolean {
  return (
    value === undefined ||
    value.owner.trim().length === 0 ||
    value.reason.trim().length === 0 ||
    !validIsoDate(value.expiresOn) ||
    !Number.isInteger(value.maxAttemptsPerInvocation) ||
    value.maxAttemptsPerInvocation <= 0 ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs <= 0 ||
    !Number.isInteger(value.clientRetryLimit) ||
    value.clientRetryLimit < 0 ||
    missingEvidence(value.evidence) ||
    lacksAstEvidence(value.evidence)
  );
}

function lacksAstEvidence(value: SourceEvidence): boolean {
  return (value.imports?.length ?? 0) === 0 && (value.calls?.length ?? 0) === 0;
}

export function validateProviderLaneInventory(lanes: readonly ProviderLaneCandidate[]): string[] {
  const problems: string[] = [];
  const knownIds = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);

  for (const lane of lanes) {
    const label = lane.id || '<missing-id>';
    const requiresRuntimeCaller = lane.disposition !== 'prune';
    const requiresDirectImporter = requiresRuntimeCaller && lane.disposition !== 'exempt';
    const missingMetadata =
      lane.id.trim().length === 0 ||
      lane.owner.trim().length === 0 ||
      lane.disposition.trim().length === 0 ||
      lane.provider.trim().length === 0 ||
      lane.model.trim().length === 0 ||
      lane.endpointClass.trim().length === 0 ||
      lane.costSupport.trim().length === 0 ||
      missingConfiguration(lane.configuration.endpoint) ||
      missingConfiguration(lane.configuration.credential) ||
      missingConfiguration(lane.configuration.model) ||
      lane.wire.calls.length === 0 ||
      missingEvidence(lane.wire) ||
      missingEvidence(lane.evidence) ||
      (lane.disposition !== 'prune' && lacksAstEvidence(lane.evidence)) ||
      lane.roles.some((role) => role !== 'api' && role !== 'worker' && role !== 'operator') ||
      (requiresRuntimeCaller && (lane.callers.length === 0 || lane.roles.length === 0)) ||
      (requiresDirectImporter && lane.directImporters.length === 0) ||
      (lane.disposition === 'exempt' &&
        (lane.roles.length !== 1 || lane.roles[0] !== 'operator')) ||
      lane.directImporters.some(
        (importer) =>
          importer.path.trim().length === 0 ||
          !['runtime', 'type', 're-export', 'dynamic'].includes(importer.kind),
      ) ||
      lane.callers.some((caller) => missingEvidence(caller) || lacksAstEvidence(caller));
    if (missingMetadata) problems.push(`${label}: missing required metadata`);
    if (missingAttemptSemantics(lane.attemptSemantics)) {
      problems.push(`${label}: missing required attempt semantics`);
    }
    problems.push(...attemptCardinalityProblems(label, lane.attemptSemantics));
    if (!['migrate', 'opaque', 'prune', 'exempt'].includes(lane.disposition)) {
      problems.push(`${label}: unsupported disposition ${lane.disposition}`);
    }
    if (lane.disposition === 'exempt') {
      if (missingExemption(lane.exemption)) {
        problems.push(`${label}: missing required exemption metadata`);
      } else if (lane.exemption && lane.exemption.expiresOn < today) {
        problems.push(`${label}: expired exemption ${lane.exemption.expiresOn}`);
      }
      if (lane.exemption && lane.attemptSemantics?.attemptsPerInvocation?.kind === 'dynamic') {
        problems.push(`${label}: exempt lane requires exact attemptsPerInvocation`);
      } else if (
        lane.exemption &&
        lane.attemptSemantics?.attemptsPerInvocation?.kind === 'exact' &&
        (lane.attemptSemantics.attemptsPerInvocation.value !==
          lane.exemption.maxAttemptsPerInvocation ||
          lane.attemptSemantics.transportRetryCount !== lane.exemption.clientRetryLimit)
      ) {
        problems.push(`${label}: exemption attempt cardinality drift`);
      }
    } else if (lane.exemption !== undefined) {
      problems.push(`${label}: exemption metadata requires exempt disposition`);
    }
    if (knownIds.has(lane.id)) problems.push(`${label}: duplicate lane id`);
    knownIds.add(lane.id);
  }

  return problems.sort((left, right) => left.localeCompare(right));
}
