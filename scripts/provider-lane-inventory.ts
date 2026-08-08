export type ProviderLaneDisposition = 'migrate' | 'opaque' | 'prune';

export type SourceEvidence = {
  readonly path: string;
  readonly imports?: readonly string[];
  readonly calls?: readonly string[];
  readonly contains?: readonly string[];
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

export type ProviderLane = {
  readonly id: string;
  readonly owner: string;
  readonly disposition: ProviderLaneDisposition;
  readonly wire: WireEvidence;
  readonly callers: readonly SourceEvidence[];
  readonly roles: readonly ('api' | 'worker')[];
  readonly provider: string;
  readonly model: string;
  readonly endpointClass: string;
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
    roles: ['api', 'worker'],
    provider: 'DashScope',
    model: 'text-embedding-v4 fixed in source',
    endpointClass: 'OpenAI-compatible embeddings POST /embeddings',
    evidence: {
      path: 'src/server/ai/embed.ts',
      contains: ['DASHSCOPE_API_KEY', 'EMBED_MODEL', 'EMBED_DIMS'],
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
    roles: ['worker'],
    provider: 'GLM via Mem0 LLM configuration',
    model: 'env-resolved MEM0_LLM_MODEL through resolveGlmConfig',
    endpointClass: 'OpenAI-compatible chat completions POST /chat/completions',
    evidence: {
      path: 'src/capabilities/knowledge/server/propose_edge.ts',
      contains: ['onUsage', 'writeCostLedger', 'resolveGlmConfig'],
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
    roles: [],
    provider: 'GLM historical implementation',
    model: 'historical only; not runtime truth',
    endpointClass: 'historical OpenAI-compatible chat completions',
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
    roles: ['worker'],
    provider: 'GLM via Mem0 LLM configuration',
    model: 'env-resolved MEM0_LLM_MODEL; hardcoded ledger text is not model truth',
    endpointClass: 'OpenAI-compatible chat completions POST /chat/completions',
    evidence: {
      path: 'src/server/memory/triggers.ts',
      contains: ['onUsage', 'writeCostLedger', "task_kind: 'memory_reconcile'"],
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
    roles: ['worker'],
    provider: 'GLM OCR',
    model: 'glm-ocr fixed in source',
    endpointClass: 'GLM layout_parsing POST endpoint',
    evidence: {
      path: 'src/capabilities/ingestion/jobs/tencent_ocr_extract.ts',
      contains: ['glmPromptTokens', 'calculateGlmOcrCost', "provider: 'glm'"],
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
    roles: ['api', 'worker'],
    provider: 'Mem0 OSS configured with project LLM and embedder',
    model: 'opaque model-bearing memory.add and memory.search operations',
    endpointClass: 'Mem0 SDK add/search, including infer:false embedding writes',
    evidence: {
      path: 'src/server/memory/client.ts',
      contains: ['infer: false', 'memory.add', 'memory.search'],
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
    roles: ['worker'],
    provider: 'Tencent Cloud OCR',
    model: 'provider-managed QuestionMarkAgent',
    endpointClass: 'Tencent SDK SubmitQuestionMarkAgentJob and DescribeQuestionMarkAgentJob',
    evidence: {
      path: 'src/capabilities/ingestion/server/tencent_mark.ts',
      contains: ['SubmitQuestionMarkAgentJob', 'DescribeQuestionMarkAgentJob'],
    },
    costSupport:
      'no project-side provider usage or per-wire cost truth; OCR ledger records zero cost',
  },
] as const satisfies readonly ProviderLane[];

function missingEvidence(value: SourceEvidence): boolean {
  return (
    value.path.trim().length === 0 ||
    ![value.imports, value.calls, value.contains].some((items) => (items?.length ?? 0) > 0) ||
    [value.imports, value.calls, value.contains].some((items) =>
      items?.some((item) => item.trim().length === 0),
    )
  );
}

function callerLacksAstEvidence(value: SourceEvidence): boolean {
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
      lane.wire.calls.length === 0 ||
      missingEvidence(lane.wire) ||
      missingEvidence(lane.evidence) ||
      lane.roles.some((role) => role !== 'api' && role !== 'worker') ||
      (lane.disposition !== 'prune' && (lane.callers.length === 0 || lane.roles.length === 0)) ||
      lane.callers.some((caller) => missingEvidence(caller) || callerLacksAstEvidence(caller));
    if (missingMetadata) problems.push(`${label}: missing required metadata`);
    if (!['migrate', 'opaque', 'prune'].includes(lane.disposition)) {
      problems.push(`${label}: unsupported disposition ${lane.disposition}`);
    }
    if (knownIds.has(lane.id)) problems.push(`${label}: duplicate lane id`);
    knownIds.add(lane.id);
  }

  return problems.sort((left, right) => left.localeCompare(right));
}
