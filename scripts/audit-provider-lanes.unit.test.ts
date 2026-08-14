/* SIZE_OK: the fixture-heavy audit matrix shares one temporary-project DSL and one census contract. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditProviderLanes,
  collectProjectImportEdges,
  collectProviderWireFindings,
} from './audit-provider-lanes';
import {
  PROVIDER_LANES,
  type ProviderLane,
  validateProviderLaneInventory,
} from './provider-lane-inventory';

const temporaryRoots: string[] = [];

function write(root: string, path: string, contents: string): void {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function makeFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'provider-lanes-'));
  temporaryRoots.push(root);
  write(
    root,
    'src/server/ai/embed.ts',
    "export const embed = () => fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
  );
  write(
    root,
    'src/server/consumer.ts',
    "import { embed } from './ai/embed.js';\nexport { embed };\n",
  );
  write(root, 'src/capabilities/example/jobs/consumer.ts', "import '@/server/consumer';\n");
  write(
    root,
    'src/capabilities/example/manifest.ts',
    "export const manifest = { jobs: { handlers: [{ load: () => import('./jobs/consumer') }] } };\n",
  );
  write(
    root,
    'src/capabilities/index.ts',
    "import { exampleCapability } from './example/manifest';\nexport const capabilities = [exampleCapability];\n",
  );
  return root;
}

function fixtureLane(overrides: Partial<ProviderLane> = {}): ProviderLane {
  return {
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
        path: 'src/server/ai/embed.ts',
        calls: ['fetch'],
      },
    ],
    directImporters: [{ path: 'src/server/consumer.ts', kind: 'runtime' }],
    roles: ['worker'],
    provider: 'DashScope',
    model: 'text-embedding-v4',
    endpointClass: 'OpenAI-compatible embeddings',
    configuration: {
      endpoint: {
        summary: 'fixture endpoint',
        source: { path: 'src/server/ai/embed.ts', calls: ['fetch'] },
      },
      credential: {
        summary: 'fixture credential',
        source: { path: 'src/server/ai/embed.ts', calls: ['fetch'] },
      },
      model: {
        summary: 'fixture model',
        source: { path: 'src/server/ai/embed.ts', calls: ['fetch'] },
      },
    },
    evidence: {
      path: 'src/server/ai/embed.ts',
      calls: ['fetch'],
      contains: ['fetch', '/embeddings'],
    },
    attemptSemantics: {
      admittedUnit: 'one fixture provider request',
      durableIdentity: 'one fixture attempt identity',
      timeout: 'bounded fixture timeout',
      clientRetry: 'no fixture client retry',
      redelivery: 'no fixture redelivery',
      fanOut: 'one fixture request',
      evidence: [{ path: 'src/server/ai/embed.ts', calls: ['fetch'] }],
    },
    costSupport: 'no project-side per-wire ledger hook',
    ...overrides,
  };
}

function configurationFixture(
  endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  credential = 'DASHSCOPE_API_KEY',
  model = 'text-embedding-v4',
): string {
  return `const BASE_URL = process.env.MEM0_EMBEDDING_BASE_URL?.trim() || '${endpoint}';
const apiKey = process.env.${credential}?.trim();
export const embed = () => fetch(\`${'${BASE_URL}'}/embeddings\`, { body: JSON.stringify({ model: '${model}', apiKey }) });
`;
}

function configuredFixtureLane(): ProviderLane {
  return {
    ...fixtureLane(),
    configuration: {
      endpoint: {
        summary: 'env-configurable compatible endpoint with DashScope default',
        source: {
          path: 'src/server/ai/embed.ts',
          envReads: ['MEM0_EMBEDDING_BASE_URL'],
          literals: ['https://dashscope.aliyuncs.com/compatible-mode/v1'],
        },
      },
      credential: {
        summary: 'DashScope API key environment credential',
        source: { path: 'src/server/ai/embed.ts', envReads: ['DASHSCOPE_API_KEY'] },
      },
      model: {
        summary: 'fixed embedding model literal',
        source: { path: 'src/server/ai/embed.ts', literals: ['text-embedding-v4'] },
      },
    },
  };
}

function glmFixtureLane(): ProviderLane {
  return fixtureLane({
    id: 'glm.memory-reconcile',
    wire: {
      path: 'src/server/memory/reconcile-llm.ts',
      calls: ['fetchImpl'],
      contains: ['judgeReconciliation', '/chat/completions'],
    },
    callers: [
      {
        path: 'src/server/memory/glm-consumer.ts',
        imports: ['./reconcile-llm.js'],
      },
    ],
    directImporters: [{ path: 'src/server/memory/glm-consumer.ts', kind: 'runtime' }],
    configuration: {
      endpoint: {
        summary: 'fixture endpoint',
        source: { path: 'src/server/memory/reconcile-llm.ts', calls: ['fetchImpl'] },
      },
      credential: {
        summary: 'fixture credential',
        source: { path: 'src/server/memory/reconcile-llm.ts', calls: ['fetchImpl'] },
      },
      model: {
        summary: 'fixture model',
        source: { path: 'src/server/memory/reconcile-llm.ts', calls: ['fetchImpl'] },
      },
    },
    evidence: {
      path: 'src/server/memory/reconcile-llm.ts',
      calls: ['fetchImpl'],
      contains: ['judgeReconciliation', '/chat/completions'],
    },
  });
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('provider lane inventory', () => {
  it('declares admitted-unit and multiplication semantics for every inventory lane', () => {
    expect(
      PROVIDER_LANES.map((lane) => ({
        id: lane.id,
        hasAttemptSemantics: Object.hasOwn(lane, 'attemptSemantics'),
      })),
    ).toEqual(PROVIDER_LANES.map((lane) => ({ id: lane.id, hasAttemptSemantics: true })));
  });

  it('rejects inventory lanes without source-backed attempt semantics', () => {
    expect(
      validateProviderLaneInventory([{ ...fixtureLane(), attemptSemantics: undefined }]),
    ).toContain('dashscope.embedding: missing required attempt semantics');
  });

  it('rejects expired or incomplete support exemptions', () => {
    const expired = {
      ...fixtureLane(),
      disposition: 'exempt',
      exemption: {
        owner: 'server/ai',
        reason: 'manual operator probe',
        expiresOn: '2000-01-01',
        maxAttemptsPerInvocation: 1,
        timeoutMs: 30_000,
        clientRetryLimit: 0,
        evidence: { path: 'src/server/ai/embed.ts', calls: ['fetch'] },
      },
    };
    const incomplete = {
      ...expired,
      id: 'incomplete.support-probe',
      exemption: { ...expired.exemption, owner: '' },
    };

    expect(validateProviderLaneInventory([expired, incomplete])).toEqual(
      expect.arrayContaining([
        'dashscope.embedding: expired exemption 2000-01-01',
        'incomplete.support-probe: missing required exemption metadata',
      ]),
    );
  });

  it('declares the vision preflight as one bounded operator-only exemption', () => {
    const lane = PROVIDER_LANES.find((candidate) => candidate.id === 'xiaomi.vision-preflight');
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/preflight-vision-one-shot.ts'),
      'utf8',
    );

    expect(lane).toMatchObject({
      disposition: 'exempt',
      roles: ['operator'],
      wire: { calls: ['client.messages.create'] },
      exemption: {
        maxAttemptsPerInvocation: 1,
        timeoutMs: 30_000,
        clientRetryLimit: 0,
      },
    });
    expect(source.match(/client\.messages\.create\(/gu)).toHaveLength(1);
    expect(source).toContain('maxRetries: 0');
    expect(source).toContain('timeout: 30_000');
  });

  it('lists each current direct provider lane with complete immutable metadata', () => {
    expect(PROVIDER_LANES.map((lane) => lane.id)).toEqual([
      'dashscope.embedding',
      'glm.knowledge-edge-reconcile',
      'glm.knowledge-misconception-reconcile',
      'glm.memory-reconcile',
      'glm.ocr-layout-parsing',
      'mem0.event-memory',
      'tencent.question-mark-agent',
      'xiaomi.vision-preflight',
    ]);
    expect(validateProviderLaneInventory(PROVIDER_LANES)).toEqual([]);
    expect(PROVIDER_LANES.map((lane) => ({ id: lane.id, calls: lane.wire.calls }))).toEqual([
      { id: 'dashscope.embedding', calls: ['fetch'] },
      { id: 'glm.knowledge-edge-reconcile', calls: ['fetchImpl'] },
      { id: 'glm.knowledge-misconception-reconcile', calls: ['fetchImpl'] },
      { id: 'glm.memory-reconcile', calls: ['fetchImpl'] },
      { id: 'glm.ocr-layout-parsing', calls: ['fetch'] },
      {
        id: 'mem0.event-memory',
        calls: ['memory.add', 'memory.add', 'memory.add', 'memory.search'],
      },
      {
        id: 'tencent.question-mark-agent',
        calls: ['client.SubmitQuestionMarkAgentJob', 'client.DescribeQuestionMarkAgentJob'],
      },
      { id: 'xiaomi.vision-preflight', calls: ['client.messages.create'] },
    ]);
  });

  it('finds an unlisted direct provider fetch in a project fixture', () => {
    const root = makeFixture();
    expect(collectProviderWireFindings(root)).toEqual([
      {
        call: 'fetch',
        kind: 'dashscope-embedding-fetch',
        path: 'src/server/ai/embed.ts',
      },
    ]);
    expect(auditProviderLanes(root, [])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
      ],
    });
  });

  it.each([
    ['owner', fixtureLane({ owner: '' })],
    ['callers', fixtureLane({ callers: [] })],
    ['evidence', fixtureLane({ evidence: { path: '', contains: [] } })],
    ['disposition', { ...fixtureLane(), disposition: '' }],
  ])('rejects a lane missing required %s metadata', (_category, lane) => {
    expect(validateProviderLaneInventory([lane])).toEqual(
      expect.arrayContaining([expect.stringContaining('missing required metadata')]),
    );
  });

  it('fails closed when caller evidence drifts from the declared import or call path', () => {
    const root = makeFixture();
    const lane = fixtureLane({
      callers: [
        {
          path: 'src/server/ai/embed.ts',
          calls: ['missingImportOrCall'],
        },
      ],
    });
    expect(auditProviderLanes(root, [lane])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({ reason: expect.stringContaining('no longer matches') }),
      ],
    });
  });

  it('rejects caller evidence that only repeats source text without an AST import or call', () => {
    const root = makeFixture();
    const lane = fixtureLane({
      callers: [
        {
          path: 'src/server/ai/embed.ts',
          contains: ['embed'],
        },
      ],
    });
    expect(auditProviderLanes(root, [lane])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({ reason: expect.stringContaining('missing required metadata') }),
      ],
    });
  });

  it('rejects a changed declared DashScope endpoint default even when the embeddings path remains', () => {
    const root = makeFixture();
    write(root, 'src/server/ai/embed.ts', configurationFixture('https://unapproved.example/v1'));
    expect(auditProviderLanes(root, [configuredFixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'src/server/ai/embed.ts',
          reason: expect.stringContaining(
            'configuration endpoint evidence no longer matches declared literal',
          ),
        }),
      ],
    });
  });

  it.each([
    ['credential', configurationFixture(undefined, 'UNAPPROVED_API_KEY')],
    ['model', configurationFixture(undefined, undefined, 'other-embedding-model')],
  ])('rejects a changed DashScope %s configuration source', (kind, source) => {
    const root = makeFixture();
    write(root, 'src/server/ai/embed.ts', source);
    expect(auditProviderLanes(root, [configuredFixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'src/server/ai/embed.ts',
          reason: expect.stringContaining(
            kind === 'credential'
              ? 'configuration credential evidence no longer matches declared env read'
              : 'configuration model evidence no longer matches declared literal',
          ),
        }),
      ],
    });
  });

  it('rejects reintroduction of a pruned misconception reconcile module', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/knowledge/server/misconception-reconcile.ts', 'export {}\n');
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('pruned module was reintroduced'),
        }),
      ],
    });
  });

  it('rejects a relative import of a pruned misconception reconcile module', () => {
    const root = makeFixture();
    write(
      root,
      'src/capabilities/knowledge/server/consumer.ts',
      "import './misconception-reconcile';\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('pruned misconception reconcile module is imported'),
        }),
      ],
    });
  });

  it('fails closed on a new backend fetch that is not classified as a provider lane', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/other-provider.ts',
      "export const call = () => fetch('https://new.example/v1');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
      ],
    });
  });

  it('fails closed on a second fetch in the declared DashScope wire file', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/ai/embed.ts',
      "export const embed = () => fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\nexport const second = () => fetch('https://other.example/embeddings');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('wire call count drift'),
        }),
      ],
    });
  });

  it('classifies a local fetch alias as the declared direct provider wire', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/ai/embed.ts',
      "const request = fetch;\nexport const embed = () => request('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    );
    expect(collectProviderWireFindings(root)).toEqual([
      {
        call: 'fetch',
        kind: 'dashscope-embedding-fetch',
        path: 'src/server/ai/embed.ts',
      },
    ]);
    expect(auditProviderLanes(root, [fixtureLane()]).ok).toBe(true);
  });

  it.each([
    [
      "export const embed = () => globalThis.fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    ],
    [
      "const request = global.fetch;\nexport const embed = () => request('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    ],
    [
      "const { fetch: request } = globalThis;\nexport const embed = () => request('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    ],
    [
      "export const embed = () => globalThis['fetch']('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    ],
    [
      "const request = global['fetch'];\nexport const embed = () => request('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    ],
  ])('classifies Node global Fetch member syntax as fetch', (source) => {
    const root = makeFixture();
    write(root, 'src/server/ai/embed.ts', source);
    expect(collectProviderWireFindings(root)).toContainEqual({
      call: 'fetch',
      kind: 'dashscope-embedding-fetch',
      path: 'src/server/ai/embed.ts',
    });
    expect(auditProviderLanes(root, [fixtureLane()]).ok).toBe(true);
  });

  it('does not classify imported Undici fetch implementations as provider wires', () => {
    const root = makeFixture();
    write(
      root,
      'src/capabilities/ingestion/server/pinned-fetch.ts',
      "import { fetch as undiciFetch } from 'undici';\nexport const download = () => undiciFetch('https://content.example/file');\n",
    );
    write(
      root,
      'src/capabilities/ingestion/server/image-candidate-accept.ts',
      "import { fetchWithPinnedDispatcher } from '@/capabilities/ingestion/server/pinned-fetch';\nvoid fetchWithPinnedDispatcher;\n",
    );
    expect(collectProviderWireFindings(root)).toEqual([
      {
        call: 'fetch',
        kind: 'dashscope-embedding-fetch',
        path: 'src/server/ai/embed.ts',
      },
    ]);
    expect(auditProviderLanes(root, [fixtureLane()]).ok).toBe(true);
  });

  it('rejects extra protected fetch calls and wrapper importers', () => {
    const root = makeFixture();
    write(
      root,
      'src/capabilities/ingestion/server/pinned-fetch.ts',
      "import { fetch as undiciFetch } from 'undici';\nexport const download = () => undiciFetch('https://content.example/file');\nexport const extra = () => undiciFetch('https://content.example/extra');\n",
    );
    write(
      root,
      'src/capabilities/ingestion/server/image-candidate-accept.ts',
      "import { fetchWithPinnedDispatcher } from '@/capabilities/ingestion/server/pinned-fetch';\nvoid fetchWithPinnedDispatcher;\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('imported fetch exception no longer matches'),
        }),
      ],
    });
    write(
      root,
      'src/capabilities/ingestion/server/pinned-fetch.ts',
      "import { fetch as undiciFetch } from 'undici';\nexport const download = () => undiciFetch('https://content.example/file');\n",
    );
    write(
      root,
      'src/server/extra-pinned-consumer.ts',
      "import { fetchWithPinnedDispatcher as extraPinnedFetch } from '@/capabilities/ingestion/server/pinned-fetch';\nvoid extraPinnedFetch;\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('imported fetch exception no longer matches'),
        }),
      ],
    });
  });

  it('preserves fetchImpl identity through a local alias chain', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/memory/reconcile-llm.ts',
      "const request = fetchImpl;\nconst send = request;\nexport const judgeReconciliation = () => send('/chat/completions');\n",
    );
    write(
      root,
      'src/server/memory/glm-consumer.ts',
      "import { judgeReconciliation } from './reconcile-llm.js';\nexport { judgeReconciliation };\n",
    );
    write(
      root,
      'src/capabilities/example/jobs/glm-consumer.ts',
      "import '@/server/memory/glm-consumer';\n",
    );
    write(
      root,
      'src/capabilities/example/manifest.ts',
      "export const manifest = { jobs: { handlers: [{ load: () => import('./jobs/consumer') }, { load: () => import('./jobs/glm-consumer') }] } };\n",
    );
    expect(collectProviderWireFindings(root)).toContainEqual({
      call: 'fetchImpl',
      kind: 'glm-memory-reconcile-fetch',
      path: 'src/server/memory/reconcile-llm.ts',
    });
    expect(auditProviderLanes(root, [fixtureLane(), glmFixtureLane()]).ok).toBe(true);
  });

  it('fails closed on an undeclared direct importer of a wire', () => {
    const root = makeFixture();
    write(root, 'src/server/undeclared.ts', "import './ai/embed';\n");
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('direct importer closure drift'),
        }),
      ],
    });
  });

  it('fails when API role reachability changes without changing a direct importer', () => {
    const root = makeFixture();
    const lane = fixtureLane({ roles: ['api', 'worker'] });
    write(root, 'src/capabilities/example/api/consumer.ts', "import '@/server/consumer';\n");
    write(
      root,
      'src/capabilities/example/manifest.ts',
      "export const manifest = { api: { routes: [{ load: () => import('./api/consumer') }] }, jobs: { handlers: [{ load: () => import('./jobs/consumer') }] } };\n",
    );
    expect(auditProviderLanes(root, [lane]).ok).toBe(true);
    rmSync(resolve(root, 'src/capabilities/example/api/consumer.ts'));
    expect(auditProviderLanes(root, [lane])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({ reason: expect.stringContaining('runtime role closure drift') }),
      ],
    });
  });

  it('uses the top-level exported capabilities array despite nested shadows', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/example/api/consumer.ts', "import '@/server/consumer';\n");
    write(
      root,
      'src/capabilities/example/manifest.ts',
      "export const manifest = { api: { routes: [{ load: () => import('./api/consumer') }] }, jobs: { handlers: [{ load: () => import('./jobs/consumer') }] } };\n",
    );
    write(
      root,
      'src/capabilities/index.ts',
      "import { exampleCapability } from './example/manifest';\nexport const capabilities = [exampleCapability];\nfunction shadow() { const capabilities = []; return capabilities; }\nvoid shadow;\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: 'runtime role closure drift: expected worker; observed api, worker',
        }),
      ],
    });
  });

  it('uses only registered manifest loaders and direct server app dependencies for API roles', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/example/api/orphan.ts', "import '@/server/consumer';\n");
    expect(auditProviderLanes(root, [fixtureLane()]).ok).toBe(true);
    write(root, 'server/app.ts', "import './app-helper';\n");
    write(root, 'server/app-helper.ts', "import '../src/server/consumer';\n");
    expect(auditProviderLanes(root, [fixtureLane({ roles: ['api', 'worker'] })]).ok).toBe(true);
  });

  it('does not derive roles from an orphan manifest outside capabilities index', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/orphan/api/consumer.ts', "import '@/server/consumer';\n");
    write(
      root,
      'src/capabilities/orphan/manifest.ts',
      "export const orphanCapability = { api: { routes: [{ load: () => import('./api/consumer') }] } };\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()]).ok).toBe(true);
  });

  it('fails closed on an imported provider fetch outside the pinned transport exception', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/provider-fetch.ts',
      "import { fetch as providerFetch } from 'undici';\nexport const call = () => providerFetch('https://provider.example/v1');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
      ],
    });
  });

  it('fails closed on a watched provider SDK import from a production composition root', () => {
    const root = makeFixture();
    write(root, 'server/app.ts', "import { OpenAI } from 'openai';\nvoid OpenAI;\n");
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({ reason: 'unlisted provider SDK runtime import: openai' }),
      ],
    });
  });

  it('fails closed on an unlisted direct provider SDK operator script', () => {
    const root = makeFixture();
    write(
      root,
      'scripts/provider-preflight.ts',
      "import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic({ apiKey: 'test' });\nexport const run = () => client.messages.create({ model: 'test', max_tokens: 1, messages: [] });\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'scripts/provider-preflight.ts',
          reason: 'unlisted provider SDK runtime import: @anthropic-ai/sdk',
        }),
      ],
    });
  });

  it('fails closed on an unlisted direct provider fetch operator script', () => {
    const root = makeFixture();
    write(
      root,
      'scripts/provider-fetch-preflight.ts',
      "export const run = () => fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'scripts/provider-fetch-preflight.ts',
          reason: 'unlisted direct provider wire: dashscope-embedding-fetch',
        }),
      ],
    });
  });

  it('fails closed on a watched provider SDK import in a registered API loader dependency', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/example/api/route.ts', "import './sdk-helper';\n");
    write(
      root,
      'src/capabilities/example/api/sdk-helper.ts',
      "import { OpenAI } from 'openai';\nvoid OpenAI;\n",
    );
    write(
      root,
      'src/capabilities/example/manifest.ts',
      "export const manifest = { api: { routes: [{ load: () => import('./api/route') }] }, jobs: { handlers: [{ load: () => import('./jobs/consumer') }] } };\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'src/capabilities/example/api/sdk-helper.ts',
          reason: 'unlisted provider SDK runtime import: openai',
        }),
      ],
    });
  });

  it('fails closed on an Agent SDK startup binding in a registered API loader dependency', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/example/api/route.ts', "import './sdk-helper';\n");
    write(
      root,
      'src/capabilities/example/api/sdk-helper.ts',
      "import { startup } from '@anthropic-ai/claude-agent-sdk';\nvoid startup;\n",
    );
    write(
      root,
      'src/capabilities/example/manifest.ts',
      "export const manifest = { api: { routes: [{ load: () => import('./api/route') }] }, jobs: { handlers: [{ load: () => import('./jobs/consumer') }] } };\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'src/capabilities/example/api/sdk-helper.ts',
          reason: 'unlisted provider SDK runtime import: @anthropic-ai/claude-agent-sdk',
        }),
      ],
    });
  });

  it('does not infer API reachability from copilot loaders or the server index worker branch', () => {
    const root = makeFixture();
    write(root, 'src/capabilities/example/copilot.ts', "import '@/server/consumer';\n");
    write(root, 'server/worker-helper.ts', "import '../src/server/consumer';\n");
    write(root, 'server/index.ts', "import './worker-helper';\n");
    write(
      root,
      'src/capabilities/example/manifest.ts',
      "export const manifest = { jobs: { handlers: [{ load: () => import('./jobs/consumer') }] }, copilotTools: { tools: [{ load: () => import('./copilot') }] } };\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()]).ok).toBe(true);
  });

  it('requires executable ledger evidence rather than retained ledger text', () => {
    const root = makeFixture();
    const lane = fixtureLane({
      evidence: { path: 'src/server/ai/embed.ts', calls: ['writeCostLedger'] },
    });
    write(
      root,
      'src/server/ai/embed.ts',
      "const writeCostLedger = () => undefined;\nexport const embed = () => { writeCostLedger(); return fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings'); };\n",
    );
    expect(auditProviderLanes(root, [lane]).ok).toBe(true);
    write(
      root,
      'src/server/ai/embed.ts',
      "// writeCostLedger()\nconst stale = 'writeCostLedger';\nexport const embed = () => fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');\nvoid stale;\n",
    );
    expect(auditProviderLanes(root, [lane])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: 'evidence hook evidence no longer matches declared call',
        }),
      ],
    });
  });

  it('classifies re-exports, dynamic imports, explicit JavaScript specifiers, and type-only imports', () => {
    const root = makeFixture();
    write(root, 'src/server/reexport.ts', "export { embed } from './ai/embed.js';\n");
    write(root, 'src/server/dynamic.ts', "export const load = () => import('./ai/embed');\n");
    write(
      root,
      'src/server/types.ts',
      "import type { embed } from './ai/embed';\nexport type Embedded = typeof embed;\n",
    );
    expect(collectProjectImportEdges(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/server/consumer.ts', kind: 'runtime' }),
        expect.objectContaining({ path: 'src/server/reexport.ts', kind: 're-export' }),
        expect.objectContaining({ path: 'src/server/dynamic.ts', kind: 'dynamic' }),
        expect.objectContaining({ path: 'src/server/types.ts', kind: 'type' }),
      ]),
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          reason: expect.stringContaining('direct importer closure drift'),
        }),
      ],
    });
  });

  it('rejects export-from, dynamic, and explicit JavaScript imports of pruned modules but not suffix near-misses', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/reexport.ts',
      "export {} from '../capabilities/knowledge/server/misconception-reconcile.js';\n",
    );
    write(
      root,
      'src/server/dynamic.ts',
      "export const load = () => import('../capabilities/knowledge/server/misconception-reconcile');\n",
    );
    write(
      root,
      'src/server/near-miss.ts',
      "import '../capabilities/knowledge/server/not-misconception-reconcile';\n",
    );
    const result = auditProviderLanes(root, [fixtureLane()]);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/server/reexport.ts',
          reason: 'pruned misconception reconcile module is imported',
        }),
        expect.objectContaining({
          path: 'src/server/dynamic.ts',
          reason: 'pruned misconception reconcile module is imported',
        }),
      ]),
    );
    expect(result.violations).not.toContainEqual(
      expect.objectContaining({
        path: 'src/server/near-miss.ts',
        reason: 'pruned misconception reconcile module is imported',
      }),
    );
  });

  it('fails closed on a capability API fetch while excluding UI paths from the backend census', () => {
    const root = makeFixture();
    write(
      root,
      'src/capabilities/ingestion/api/provider.ts',
      "export const call = () => fetch('https://new.example/v1');\n",
    );
    write(
      root,
      'src/capabilities/ingestion/ui/client.ts',
      "export const call = () => fetch('/api/client');\n",
    );
    write(
      root,
      'server/direct-provider.ts',
      "export const call = () => fetch('https://root-server.example/v1');\n",
    );
    const result = auditProviderLanes(root, [fixtureLane()]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/capabilities/ingestion/api/provider.ts',
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
        expect.objectContaining({
          path: 'server/direct-provider.ts',
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
      ]),
    );
    expect(collectProviderWireFindings(root)).not.toContainEqual(
      expect.objectContaining({ path: 'src/capabilities/ingestion/ui/client.ts' }),
    );
  });

  it('fails closed on a provider fetch in the production worker entry', () => {
    const root = makeFixture();
    write(
      root,
      'scripts/worker.ts',
      "export const call = () => fetch('https://worker-provider.example/v1');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'scripts/worker.ts',
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
      ],
    });
  });

  it('follows a product runtime import into scripts without scanning independent operator scripts', () => {
    const root = makeFixture();
    write(root, 'server/index.ts', "import '../scripts/direct-provider.js';\n");
    write(
      root,
      'scripts/direct-provider.ts',
      "export const call = () => globalThis.fetch('https://direct-provider.example/v1');\n",
    );
    write(
      root,
      'scripts/smoke-local.ts',
      "export const call = () => globalThis.fetch('https://operator.example/v1');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'scripts/direct-provider.ts',
          reason: expect.stringContaining('unlisted direct provider wire'),
        }),
      ],
    });
    expect(collectProviderWireFindings(root)).not.toContainEqual(
      expect.objectContaining({ path: 'scripts/smoke-local.ts' }),
    );
  });

  it('fails closed on a non-literal CommonJS require from a production root', () => {
    const root = makeFixture();
    write(
      root,
      'server/index.ts',
      "const target = '../scripts/direct-provider';\nrequire(target);\n",
    );
    write(
      root,
      'scripts/direct-provider.ts',
      "export const call = () => globalThis.fetch('https://direct-provider.example/v1');\n",
    );
    expect(auditProviderLanes(root, [fixtureLane()])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({
          path: 'server/index.ts',
          reason: 'unsupported dynamic import prevents direct importer closure validation',
        }),
      ],
    });
  });

  it('censuses static, export-from, import-equals, require, and dynamic imports by exact extension', () => {
    const root = makeFixture();
    write(root, 'src/server/target-ts.ts', 'export const target = 1;\n');
    write(root, 'src/server/target-tsx.tsx', 'export const target = <div />;\n');
    write(root, 'src/server/target-js.js', 'export const target = 1;\n');
    write(root, 'src/server/target-mjs.ts', 'export const wrongTarget = true;\n');
    write(root, 'src/server/target-mjs.mjs', 'export const target = 1;\n');
    write(root, 'src/server/target-cjs.cjs', 'module.exports = { target: 1 };\n');
    write(
      root,
      'src/server/static.ts',
      "import './target-ts.ts';\nimport './target-tsx.tsx';\nimport './target-js.js';\n",
    );
    write(root, 'src/server/reexport.ts', "export { target } from './target-mjs.mjs';\n");
    write(
      root,
      'src/server/import-equals.cts',
      "import target = require('./target-cjs.cjs');\nvoid target;\n",
    );
    write(root, 'src/server/require.cjs', "require('./target-mjs.mjs');\n");
    write(root, 'src/server/dynamic.mjs', "import('./target-cjs.cjs');\n");

    const edges = collectProjectImportEdges(root);
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/server/static.ts', source: './target-ts.ts' }),
        expect.objectContaining({ path: 'src/server/static.ts', source: './target-tsx.tsx' }),
        expect.objectContaining({ path: 'src/server/static.ts', source: './target-js.js' }),
        expect.objectContaining({
          path: 'src/server/reexport.ts',
          source: './target-mjs.mjs',
          kind: 're-export',
          target: resolve(root, 'src/server/target-mjs.mjs'),
        }),
        expect.objectContaining({
          path: 'src/server/import-equals.cts',
          source: './target-cjs.cjs',
          kind: 'runtime',
        }),
        expect.objectContaining({
          path: 'src/server/require.cjs',
          source: './target-mjs.mjs',
          kind: 'runtime',
          target: resolve(root, 'src/server/target-mjs.mjs'),
        }),
        expect.objectContaining({
          path: 'src/server/dynamic.mjs',
          source: './target-cjs.cjs',
          kind: 'dynamic',
        }),
      ]),
    );
  });

  it('fails for unlisted provider SDK wires in every supported import form', () => {
    const root = makeFixture();
    write(root, 'scripts/unlisted-static.ts', "import Anthropic from '@anthropic-ai/sdk';\n");
    write(root, 'scripts/unlisted-export.ts', "export { default } from '@anthropic-ai/sdk';\n");
    write(root, 'scripts/unlisted-require.cjs', "require('@anthropic-ai/sdk');\n");
    write(
      root,
      'scripts/unlisted-import-equals.cts',
      "import Anthropic = require('@anthropic-ai/sdk');\nvoid Anthropic;\n",
    );
    write(root, 'scripts/unlisted-dynamic.mjs', "import('@anthropic-ai/sdk');\n");

    const violations = auditProviderLanes(root, [fixtureLane()]).violations.filter((violation) =>
      violation.reason.startsWith('unlisted provider SDK runtime import'),
    );
    expect(violations.map((violation) => violation.path)).toEqual([
      'scripts/unlisted-dynamic.mjs',
      'scripts/unlisted-export.ts',
      'scripts/unlisted-import-equals.cts',
      'scripts/unlisted-require.cjs',
      'scripts/unlisted-static.ts',
    ]);
  });

  it('ignores provider import text in comments and ordinary strings', () => {
    const root = makeFixture();
    write(
      root,
      'scripts/ignored.ts',
      `// import Anthropic from '@anthropic-ai/sdk';
const staticText = "export { default } from '@anthropic-ai/sdk'";
const requireText = "require('@anthropic-ai/sdk')";
const dynamicText = "import('@anthropic-ai/sdk')";
void [staticText, requireText, dynamicText];
`,
    );

    expect(auditProviderLanes(root, [fixtureLane()]).violations).not.toContainEqual(
      expect.objectContaining({ path: 'scripts/ignored.ts' }),
    );
  });

  it('excludes generated, vendor, and fixture directories from the source census', () => {
    const root = makeFixture();
    for (const directory of ['generated', '__generated__', 'vendor', 'fixtures', '__fixtures__']) {
      write(
        root,
        `src/server/${directory}/provider.ts`,
        "export const call = () => fetch('https://excluded-provider.example/v1');\n",
      );
    }

    expect(collectProviderWireFindings(root)).toEqual([
      {
        call: 'fetch',
        kind: 'dashscope-embedding-fetch',
        path: 'src/server/ai/embed.ts',
      },
    ]);
  });

  it('excludes both test and spec source variants from the provider census', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/ignored.test.ts',
      "export const call = () => fetch('https://test.example');\n",
    );
    write(
      root,
      'src/server/ignored.spec.ts',
      "export const call = () => fetch('https://spec.example');\n",
    );
    expect(collectProviderWireFindings(root)).toEqual([
      {
        call: 'fetch',
        kind: 'dashscope-embedding-fetch',
        path: 'src/server/ai/embed.ts',
      },
    ]);
  });

  it('fails closed when a source tree contains a symbolic link', () => {
    const root = makeFixture();
    write(
      root,
      'src/server/target.ts',
      "export const call = () => fetch('https://link.example');\n",
    );
    symlinkSync('target.ts', resolve(root, 'src/server/link.ts'));
    expect(() => collectProviderWireFindings(root)).toThrow('symbolic link');
  });
});
