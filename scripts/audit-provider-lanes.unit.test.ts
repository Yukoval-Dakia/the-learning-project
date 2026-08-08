import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditProviderLanes, collectProviderWireFindings } from './audit-provider-lanes';
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
    roles: ['worker'],
    provider: 'DashScope',
    model: 'text-embedding-v4',
    endpointClass: 'OpenAI-compatible embeddings',
    evidence: {
      path: 'src/server/ai/embed.ts',
      contains: ['fetch', '/embeddings'],
    },
    costSupport: 'no project-side per-wire ledger hook',
    ...overrides,
  };
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
});
