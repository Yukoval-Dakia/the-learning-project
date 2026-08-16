import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { knowledgeCapability } from '@/capabilities/knowledge/manifest';
import { DOMAIN_TOOL_ALLOWLISTS, PROPOSE_WRITE_TOOLS, READ_TOOLS } from '@/kernel/tools/allowlists';
import type { DomainTool } from '@/kernel/tools/types';
import { zodToJsonSchemaCompat } from '@/kernel/zod-json-schema';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests, getTool } from '@/server/ai/tools/registry';

const KNOWLEDGE_TOOL_NAMES = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
  'propose_knowledge_edge',
  'propose_knowledge_mutation',
] as const;

const OWNED_TOOL_CONTRACT_HASHES = {
  query_knowledge: 'c52167f3d1333187fa65a39b3ae59915569063ccf950dd021be910286cf10a81',
  get_subject_graph_overview: '0efd4d1287b9935f8063cb0f22a56068d0111091fcf8cf650b4f540239df72c4',
  expand_knowledge_subgraph: '6ac13abdb1753b85158f02fb6ead5b82a4945cf3bbb7330b0be0e4edaa05abd9',
  find_knowledge_paths: 'e7448051fabf6fc4a51e6f0aa92160aeb2c181071f9989778382ad6cc31e029c',
  propose_knowledge_edge: '4a7dda673ec70a811535135b6fccf2f4532ee2e1d1d9fe2722a0c97a7aeeab45',
  propose_knowledge_mutation: '3412ea59dd8a768df7090030308383b5abc3bd9b83ee2de41832435cf60cc401',
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
  'src/kernel/read-models/failure-attempts.ts',
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
    inputSchema: zodToJsonSchemaCompat(tool.inputSchema, {
      target: 'draft-07',
      io: 'input',
      reused: 'inline',
    }),
    outputSchema: zodToJsonSchemaCompat(tool.outputSchema, {
      target: 'draft-07',
      io: 'input',
      reused: 'inline',
    }),
  };
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

describe('knowledge server ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('deletes central owner paths, exports, and imports', () => {
    expect(existsSync(join(process.cwd(), 'src/server/ai/tools/knowledge-readers.ts'))).toBe(false);
    // YUK-892 — the transitional central concrete tool files are deleted wholesale.
    expect(existsSync(join(process.cwd(), 'src/server/ai/tools/proposal-tools.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/server/events/queries.ts'))).toBe(false);

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

    // YUK-892 — shared failure-attempt read models live in kernel/read-models;
    // the practice attempt-events seam re-publishes through the knowledge public
    // seam (its own capability contract), never a central or deep import.
    const practiceSeam = source('src/capabilities/practice/server/attempt-events.ts');
    expect(practiceSeam).not.toContain("@/server/events/queries'");
    expect(practiceSeam).not.toContain('@/kernel/read-models/failure-attempts');
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
