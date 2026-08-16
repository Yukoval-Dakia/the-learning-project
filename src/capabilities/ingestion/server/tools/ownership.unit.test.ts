import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import { DOMAIN_TOOL_ALLOWLISTS, PROPOSE_WRITE_TOOLS, READ_TOOLS } from '@/kernel/tools/allowlists';
import type { DomainTool } from '@/kernel/tools/types';
import { zodToJsonSchemaCompat } from '@/kernel/zod-json-schema';
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

const OWNED_TOOL_CONTRACT_HASHES = {
  query_records: '2ec1229c7c328364da8790d2867025fc3487472d09955e9a913598d928d5f1af',
  get_record_context: '76586011e17e30dbd31caaf90a6c31d0185bb84e281b240d38cedfb85571f695',
  get_question_block_structure: 'c5a30af758c31df75b36446f7b4204a6ba2e0c6b80f9f68dd9d0fa5aeb29b75e',
  update_prompt: '91c6e8f9a5bc994fd0f9447110200e6d6176e6dd583d096db3d7137f64e183b8',
  add_option: '6dcd33a2666b1ade9ee5df906384bcbc575ed91a1b9342c1ed9586f175398069',
  set_question_type: 'e65f39d2df45357981dac993c07ed469dcb6a8ee794fa08f52d409b82ee9eba9',
  split_stem: '6832da91dff5ffd3f1c87f209338ac3cc9a7c60d02035cf33e7a851001b13a34',
  merge_questions: '1fe7abcc20fd8cae429a5e32cc0373188ee8d8c38ad0fee67adce587266a4e06',
  reassign_figure: '6946efb343bf56018f4f85efdfbb2db2fc9647c368ff6a755f96e75d289961ee',
} as const;

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

describe('ingestion server ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('deletes central owner paths, exports, imports, and direct registrations', () => {
    expect(existsSync(join(process.cwd(), 'src/server/ai/tools/question-edit-tools.ts'))).toBe(
      false,
    );
    expect(existsSync(join(process.cwd(), 'src/server/events/ingestion-progress.ts'))).toBe(false);

    // YUK-892 — the transitional central concrete tool files are deleted wholesale.
    expect(existsSync(join(process.cwd(), 'src/server/ai/tools/context-readers.ts'))).toBe(false);

    const manifest = source('src/capabilities/ingestion/manifest.ts');
    expect(manifest).not.toContain('@/server/ai/tools/context-readers');
    expect(manifest).not.toContain('@/server/ai/tools/question-edit-tools');
    expect(source('src/capabilities/ingestion/jobs/tencent_ocr_extract.ts')).not.toContain(
      '@/server/events/ingestion-progress',
    );

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

  it('loads the unchanged tool inventory and contracts from the ingestion manifest', async () => {
    expect(ingestionCapability.copilotTools?.tools.map((tool) => tool.name)).toEqual(
      INGESTION_TOOL_NAMES,
    );

    await registerCapabilityTools([ingestionCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS];
    for (const name of INGESTION_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing ingestion tool: ${name}`);
      expect(tool.name).toBe(name);
      expect(tool.effect).toBe(INGESTION_TOOL_EFFECTS[name]);
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      expect(
        Object.entries(DOMAIN_TOOL_ALLOWLISTS)
          .filter(([, names]) => names.some((allowedName) => allowedName === name))
          .map(([surface]) => surface),
      ).toEqual(INGESTION_TOOL_EXPOSURES[name]);
    }
    for (const [name, expectedHash] of Object.entries(OWNED_TOOL_CONTRACT_HASHES)) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing ingestion tool: ${name}`);
      expect(contractFingerprint(tool), name).toBe(expectedHash);
    }
  }, 30_000);

  it('ignores description prose but detects schema and effect drift', async () => {
    await registerCapabilityTools([ingestionCapability]);
    const tool = getTool('query_records');
    expect(tool).toBeDefined();
    if (!tool) throw new Error('missing ingestion tool: query_records');
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
