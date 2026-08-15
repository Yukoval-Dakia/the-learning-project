import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { knowledgeCapability } from '@/capabilities/knowledge/manifest';
import {
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
} from '@/server/ai/tools/allowlists';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests, getTool } from '@/server/ai/tools/registry';
import type { DomainTool } from '@/server/ai/tools/types';

const KNOWLEDGE_TOOL_NAMES = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
] as const;

const OWNED_TOOL_CONTRACT_HASHES = {
  query_knowledge: 'd513fdf4d7d999532a105e8e976860489906bfdd419d999ffc3353dbd7498e1c',
  get_subject_graph_overview: '0efd4d1287b9935f8063cb0f22a56068d0111091fcf8cf650b4f540239df72c4',
  expand_knowledge_subgraph: '6ac13abdb1753b85158f02fb6ead5b82a4945cf3bbb7330b0be0e4edaa05abd9',
  find_knowledge_paths: 'e7448051fabf6fc4a51e6f0aa92160aeb2c181071f9989778382ad6cc31e029c',
  propose_knowledge_edge: '4a7dda673ec70a811535135b6fccf2f4532ee2e1d1d9fe2722a0c97a7aeeab45',
  propose_knowledge_mutation: '4d2ebc1600c97eb0a28876508890a1065161e2a4bdc267794a47a349044845d3',
} as const;

const KNOWLEDGE_TOOL_EFFECTS = {
  query_knowledge: 'read',
  get_subject_graph_overview: 'read',
  expand_knowledge_subgraph: 'read',
  find_knowledge_paths: 'read',
  propose_knowledge_edge: 'propose',
  propose_knowledge_mutation: 'propose',
} as const;

const KNOWLEDGE_TOOL_EXPOSURES = {
  query_knowledge: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'maintenance',
  ],
  get_subject_graph_overview: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'maintenance',
  ],
  expand_knowledge_subgraph: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'maintenance',
  ],
  find_knowledge_paths: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'maintenance',
  ],
  propose_knowledge_edge: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'coach',
    'maintenance',
  ],
  propose_knowledge_mutation: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'coach',
    'maintenance',
  ],
} as const;

const READER_PATHS = [
  'src/capabilities/knowledge/server/tools/knowledge-readers.ts',
  'src/capabilities/knowledge/server/events/failure-attempts.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function contractFingerprint(tool: DomainTool<unknown, unknown>): string {
  const contract = {
    name: tool.name,
    effect: tool.effect,
    costClass: tool.costClass,
    mirrorEvent: tool.mirrorEvent,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    outputSchema: zodToJsonSchema(tool.outputSchema),
  };
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

describe('knowledge server ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('deletes central owner paths, exports, and imports', () => {
    expect(existsSync(join(process.cwd(), 'src/server/ai/tools/knowledge-readers.ts'))).toBe(false);

    const centralProposalTools = source('src/server/ai/tools/proposal-tools.ts');
    for (const exportName of ['proposeKnowledgeEdgeTool', 'proposeKnowledgeMutationTool']) {
      expect(centralProposalTools).not.toContain(`export const ${exportName}`);
    }

    const centralQueries = source('src/server/events/queries.ts');
    for (const exportName of [
      'getFailureAttempts',
      'getFailureAttemptById',
      'getFailureAttemptWithReasoningTraceById',
      'getFailureAttemptsWithReasoningTrace',
      'getJudgeForAttempt',
      'getUserCauseForAttempt',
    ]) {
      expect(centralQueries).not.toContain(`export async function ${exportName}`);
    }
    expect(centralQueries).not.toContain('export type FailureAttempt');
    expect(centralQueries).not.toContain('export interface GetFailureAttemptsOpts');

    const manifest = source('src/capabilities/knowledge/manifest.ts');
    expect(manifest).not.toContain('@/server/ai/tools/knowledge-readers');
    expect(manifest).not.toContain("@/server/ai/tools/proposal-tools'");
  });

  it('shares failure-attempt read models through the knowledge public seam', () => {
    const knowledgePublic = source('src/capabilities/knowledge/public.ts');
    for (const helperName of [
      'getFailureAttempts',
      'getFailureAttemptById',
      'getJudgeForAttempt',
      'FailureAttempt',
      'failure-attempts',
    ]) {
      expect(knowledgePublic).toContain(helperName);
    }

    // The practice attempt-events seam must consume the knowledge public seam,
    // not the central event queries module it used to re-export.
    const practiceSeam = source('src/capabilities/practice/server/attempt-events.ts');
    expect(practiceSeam).not.toContain("@/server/events/queries'");
    expect(practiceSeam).toContain("from '@/capabilities/knowledge/public'");
  });

  it('loads the unchanged tool inventory and contracts from the knowledge manifest', async () => {
    expect(knowledgeCapability.copilotTools?.tools.map((tool) => tool.name)).toEqual(
      KNOWLEDGE_TOOL_NAMES,
    );

    await registerCapabilityTools([knowledgeCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS];
    for (const name of KNOWLEDGE_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing knowledge tool: ${name}`);
      expect(tool.name).toBe(name);
      expect(tool.effect).toBe(KNOWLEDGE_TOOL_EFFECTS[name]);
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      expect(
        Object.entries(DOMAIN_TOOL_ALLOWLISTS)
          .filter(([, names]) => names.some((allowedName) => allowedName === name))
          .map(([surface]) => surface),
      ).toEqual(KNOWLEDGE_TOOL_EXPOSURES[name]);
    }
    for (const [name, expectedHash] of Object.entries(OWNED_TOOL_CONTRACT_HASHES)) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing knowledge tool: ${name}`);
      expect(contractFingerprint(tool), name).toBe(expectedHash);
    }
  }, 30_000);

  it('ignores description prose but detects schema and effect drift', async () => {
    await registerCapabilityTools([knowledgeCapability]);
    const tool = getTool('query_knowledge');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('missing knowledge tool: query_knowledge');
    const baseline = contractFingerprint(tool);

    expect(contractFingerprint({ ...tool, description: 'Reworded reader guidance.' })).toBe(
      baseline,
    );
    expect(contractFingerprint({ ...tool, effect: 'write' })).not.toBe(baseline);
    expect(contractFingerprint({ ...tool, inputSchema: tool.outputSchema })).not.toBe(baseline);
  });

  it('keeps capability-owned read ports free of mutation calls', () => {
    for (const path of READER_PATHS) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
      const reader = source(path);
      expect(reader, path).not.toMatch(/\.(insert|update|delete)\s*\(/);
      expect(reader, path).not.toMatch(/\bwrite(?:AiProposal|JobEvent|SessionEvent)\s*\(/);
    }
  });
});
