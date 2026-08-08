import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      contains: ['fetch', '/embeddings'],
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
  it('lists each current direct provider lane with complete immutable metadata', () => {
    expect(PROVIDER_LANES.map((lane) => lane.id)).toEqual([
      'dashscope.embedding',
      'glm.knowledge-edge-reconcile',
      'glm.knowledge-misconception-reconcile',
      'glm.memory-reconcile',
      'glm.ocr-layout-parsing',
      'mem0.event-memory',
      'tencent.question-mark-agent',
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
      'src/server/pinned-fetch.ts',
      "import { fetch as undiciFetch } from 'undici';\nexport const download = () => undiciFetch('https://content.example/file');\n",
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
    expect(auditProviderLanes(root, [lane]).ok).toBe(true);
    rmSync(resolve(root, 'src/capabilities/example/api/consumer.ts'));
    expect(auditProviderLanes(root, [lane])).toMatchObject({
      ok: false,
      violations: [
        expect.objectContaining({ reason: expect.stringContaining('runtime role closure drift') }),
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
