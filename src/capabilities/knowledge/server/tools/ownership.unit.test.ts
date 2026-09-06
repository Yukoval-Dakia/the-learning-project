import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { knowledgeCapability } from '@/capabilities/knowledge/manifest';
import {
  CONTROL_TOOLS,
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
} from '@/kernel/tools/allowlists';
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

describe('knowledge server ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
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

  it('loads the tool inventory with the intended effects and permissions', async () => {
    expect(knowledgeCapability.copilotTools?.tools.map((tool) => tool.name)).toEqual(
      KNOWLEDGE_TOOL_NAMES,
    );

    await registerCapabilityTools([knowledgeCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS, ...CONTROL_TOOLS];
    for (const name of KNOWLEDGE_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing knowledge tool: ${name}`);
      expect(tool.name).toBe(name);
      expect(tool.effect).toBe(KNOWLEDGE_TOOL_EFFECTS[name]);
      expect(tool.costClass).toBe('local');
      expect(tool.mirrorEvent).toBe(
        KNOWLEDGE_TOOL_EFFECTS[name] === 'read' ? 'when_user_visible' : 'when_causal',
      );
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      expect(
        Object.entries(DOMAIN_TOOL_ALLOWLISTS)
          .filter(([, names]) => names.some((allowedName) => allowedName === name))
          .map(([surface]) => surface),
      ).toEqual(KNOWLEDGE_TOOL_EXPOSURES[name]);
    }
  }, 30_000);

  it('keeps capability-owned read ports free of mutation calls', () => {
    for (const path of READER_PATHS) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
      const reader = source(path);
      expect(reader, path).not.toMatch(/\.(insert|update|delete)\s*\(/);
      expect(reader, path).not.toMatch(/\bwrite(?:AiProposal|JobEvent|SessionEvent)\s*\(/);
    }
  });
});
