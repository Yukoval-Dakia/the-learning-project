import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import { PROPOSE_WRITE_TOOLS, READ_TOOLS } from '@/server/ai/tools/allowlists';
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
  query_records: '60064bff0f75131a31dde260c8037e7337b2554910037216709568b02726d94c',
  get_record_context: 'fe2c7fdf7f4c6838d59fce8b7d9c70bbcdfc40c9ba986d036e2a656ac50312b1',
  get_question_block_structure: '70c87b1520e2ee10cf813e55c5230a42bc791c988a1d4e3d8176d8b8c9986c96',
  update_prompt: '6645370b7a0d48ba54084de51da2ca830c08143cf4ef9a720effe25f0f647a41',
  add_option: '38e65e3f7e3eb5d051312a78059781645b88a2f1aa501713336e86a907da6a54',
  set_question_type: 'b5a79cbd159f5f9564ea010353a831464f4b4434641f100c3c82d91539e71781',
  split_stem: 'a296f045b6cac0536c9a904428e52620f611078284da75c5e6857c73afdaea0b',
  merge_questions: '82bea611241e1bc1f6b1dba6bfcebc344ff82243e8432f39459c74eb35554522',
  reassign_figure: '5f0ae7c69bcd795cf06de0c6e8ff22f45633b8f3819e689a594605b0877539d1',
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

  it('deletes central owner paths, exports, imports, and direct registrations', () => {
    expect(existsSync(join(process.cwd(), 'src/server/ai/tools/question-edit-tools.ts'))).toBe(
      false,
    );
    expect(existsSync(join(process.cwd(), 'src/server/events/ingestion-progress.ts'))).toBe(false);

    const centralReaders = source('src/server/ai/tools/context-readers.ts');
    for (const exportName of [
      'queryRecordsTool',
      'getRecordContextTool',
      'getQuestionBlockStructureTool',
    ]) {
      expect(centralReaders).not.toContain(`export const ${exportName}`);
    }

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
    const centralReaders = source('src/server/ai/tools/context-readers.ts');
    const ingestionPublic = source('src/capabilities/ingestion/public.ts');

    expect(centralReaders).toContain("from '@/capabilities/ingestion/public'");
    for (const helperName of ['excerpt', 'knowledgeContext', 'bodyBlockSummaries']) {
      expect(centralReaders).not.toMatch(new RegExp(`function ${helperName}\\b`));
      expect(ingestionPublic).toContain(helperName);
    }
  });

  it('loads the unchanged tool inventory and contracts from the ingestion manifest', async () => {
    expect(ingestionCapability.copilotTools?.tools.map((tool) => tool.name)).toEqual(
      INGESTION_TOOL_NAMES,
    );

    await registerCapabilityTools([ingestionCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS];
    for (const [name, expectedHash] of Object.entries(OWNED_TOOL_CONTRACT_HASHES)) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing ingestion tool: ${name}`);
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      const contract = {
        name: tool.name,
        description: tool.description,
        effect: tool.effect,
        costClass: tool.costClass,
        mirrorEvent: tool.mirrorEvent,
        inputSchema: zodToJsonSchema(tool.inputSchema),
        outputSchema: zodToJsonSchema(tool.outputSchema),
      };
      expect(createHash('sha256').update(JSON.stringify(contract)).digest('hex'), name).toBe(
        expectedHash,
      );
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
