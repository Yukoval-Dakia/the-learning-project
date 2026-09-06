import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import {
  CONTROL_TOOLS,
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
} from '@/kernel/tools/allowlists';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests, getTool } from '@/server/ai/tools/registry';

const INGESTION_TOOL_NAMES = [
  'query_records',
  'get_record_context',
  'get_question_block_structure',
  'propose_record_links',
  'propose_record_promotion',
  'update_prompt',
  'add_option',
  'set_question_type',
  'split_stem',
  'merge_questions',
  'reassign_figure',
] as const;

const INGESTION_TOOL_EFFECTS = {
  query_records: 'read',
  get_record_context: 'read',
  get_question_block_structure: 'read',
  propose_record_links: 'propose',
  propose_record_promotion: 'propose',
  update_prompt: 'write',
  add_option: 'write',
  set_question_type: 'write',
  split_stem: 'write',
  merge_questions: 'write',
  reassign_figure: 'write',
} as const;

const INGESTION_TOOL_EXPOSURES = {
  query_records: ['copilot', 'copilot_user_suggested_mistake_action', 'dreaming', 'maintenance'],
  get_record_context: ['copilot', 'copilot_user_suggested_mistake_action', 'maintenance'],
  get_question_block_structure: ['ingestion_block_edit'],
  propose_record_links: ['dreaming', 'maintenance'],
  propose_record_promotion: ['dreaming', 'maintenance'],
  update_prompt: ['ingestion_block_edit'],
  add_option: ['ingestion_block_edit'],
  set_question_type: ['ingestion_block_edit'],
  split_stem: ['ingestion_block_edit'],
  merge_questions: ['ingestion_block_edit'],
  reassign_figure: ['ingestion_block_edit'],
} as const;

const READER_PATHS = [
  'src/capabilities/ingestion/server/tools/query-records.ts',
  'src/capabilities/ingestion/server/tools/get-record-context.ts',
  'src/capabilities/ingestion/server/tools/question-block-structure.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('ingestion server ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('keeps concrete registrations out of the central registry infrastructure', () => {
    const directRegistrySources = [
      source('src/server/ai/tools/register-capability-tools.ts'),
      source('src/server/ai/tools/registry.ts'),
    ].join('\n');
    for (const name of INGESTION_TOOL_NAMES) {
      expect(directRegistrySources).not.toContain(`'${name}'`);
    }
  });

  it('shares record read-model semantics through the ingestion public seam', () => {
    // YUK-892 — the composite question-context reader moved to Practice; it must
    // still consume ingestion-owned material context through the public seam.
    const questionContext = source('src/capabilities/practice/server/tools/question-context.ts');
    const ingestionPublic = source('src/capabilities/ingestion/public.ts');

    expect(questionContext).toContain("from '@/capabilities/ingestion/public'");
    for (const helperName of ['excerpt', 'knowledgeContext', 'bodyBlockSummaries']) {
      expect(questionContext).not.toMatch(new RegExp(`function ${helperName}\\b`));
      expect(ingestionPublic).toContain(helperName);
    }
  });

  it('loads owned tools with the intended effects, costs and permissions', async () => {
    expect(ingestionCapability.copilotTools?.tools.map((tool) => tool.name)).toEqual(
      INGESTION_TOOL_NAMES,
    );

    await registerCapabilityTools([ingestionCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS, ...CONTROL_TOOLS];
    for (const name of INGESTION_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing ingestion tool: ${name}`);
      expect(tool.name).toBe(name);
      expect(tool.effect).toBe(INGESTION_TOOL_EFFECTS[name]);
      expect(tool.costClass).toBe('local');
      expect(tool.mirrorEvent).toBe(
        INGESTION_TOOL_EFFECTS[name] === 'read' ? 'when_user_visible' : 'when_causal',
      );
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      expect(
        Object.entries(DOMAIN_TOOL_ALLOWLISTS)
          .filter(([, names]) => names.some((allowedName) => allowedName === name))
          .map(([surface]) => surface),
      ).toEqual(INGESTION_TOOL_EXPOSURES[name]);
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
