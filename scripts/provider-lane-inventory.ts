export type ProviderLaneDisposition = 'migrate' | 'opaque' | 'prune';

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
    };

export type ProviderLane = {
  readonly id: string;
  readonly owner: string;
  readonly disposition: ProviderLaneDisposition;
  readonly wire: WireEvidence;
  readonly callers: readonly SourceEvidence[];
  readonly directImporters: readonly DirectImporter[];
  readonly roles: readonly ('api' | 'worker')[];
  readonly provider: string;
  readonly model: string;
  readonly endpointClass: string;
  readonly configuration: ProviderConfigurationTruth;
  readonly evidence: SourceEvidence;
  readonly costSupport: string;
};

export type ProviderLaneCandidate = Omit<ProviderLane, 'disposition'> & {
  readonly disposition: string;
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
      calls: ['fetch'],
      contains: ['/embeddings'],
    },
    costSupport: 'no project-side per-wire cost ledger hook in the direct embedding client',
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
      path: 'src/capabilities/knowledge/server/propose_edge.ts',
      calls: ['writeCostLedger'],
    },
    costSupport: 'per-wire cost_ledger hook records resolved model and token usage',
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
      path: 'src/server/memory/triggers.ts',
      calls: ['writeCostLedger'],
      contains: ["task_kind: 'memory_reconcile'"],
    },
    costSupport: 'per-wire cost_ledger hook records usage; model identity remains env-resolved',
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
      path: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts',
      calls: ['writeCostLedger', 'calculateGlmOcrCost'],
      contains: ["provider: 'glm'"],
    },
    costSupport: 'per-page usage accumulated and written to cost_ledger on success and failure',
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
        calls: ['client.addEventMemory', 'client.addVerbatimOnce'],
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
    costSupport: 'no project-side per-wire cost truth for opaque Mem0 operations',
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
      path: 'src/capabilities/ingestion/server/tencent_mark.ts',
      calls: ['client.SubmitQuestionMarkAgentJob', 'client.DescribeQuestionMarkAgentJob'],
    },
    costSupport:
      'no project-side provider usage or per-wire cost truth; OCR ledger records zero cost',
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

function lacksAstEvidence(value: SourceEvidence): boolean {
  return (value.imports?.length ?? 0) === 0 && (value.calls?.length ?? 0) === 0;
}

export function validateProviderLaneInventory(lanes: readonly ProviderLaneCandidate[]): string[] {
  const problems: string[] = [];
  const knownIds = new Set<string>();

  for (const lane of lanes) {
    const label = lane.id || '<missing-id>';
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
      lane.roles.some((role) => role !== 'api' && role !== 'worker') ||
      (lane.disposition !== 'prune' && (lane.callers.length === 0 || lane.roles.length === 0)) ||
      (lane.disposition !== 'prune' && lane.directImporters.length === 0) ||
      lane.directImporters.some(
        (importer) =>
          importer.path.trim().length === 0 ||
          !['runtime', 'type', 're-export', 'dynamic'].includes(importer.kind),
      ) ||
      lane.callers.some((caller) => missingEvidence(caller) || lacksAstEvidence(caller));
    if (missingMetadata) problems.push(`${label}: missing required metadata`);
    if (!['migrate', 'opaque', 'prune'].includes(lane.disposition)) {
      problems.push(`${label}: unsupported disposition ${lane.disposition}`);
    }
    if (knownIds.has(lane.id)) problems.push(`${label}: duplicate lane id`);
    knownIds.add(lane.id);
  }

  return problems.sort((left, right) => left.localeCompare(right));
}
