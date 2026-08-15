import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { agencyCapability } from '@/capabilities/agency/manifest';
import {
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
} from '@/server/ai/tools/allowlists';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests, getTool } from '@/server/ai/tools/registry';
import type { DomainTool } from '@/server/ai/tools/types';

const AGENCY_TOOL_NAMES = [
  'get_learning_item_context',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_learning_item_defer',
  'propose_learning_item_archive',
] as const;

const AGENCY_TOOL_CONTRACT_HASHES = {
  get_learning_item_context: 'f77f6fca2b98528000982a2dc728d6c10dcf1cc424b0271843a9ca0deea1da9a',
  propose_learning_item_completion:
    '8099f4796d96a2ec50d3bc738b55aeb09ce69c8bb951250a39888d8aa5d0fb25',
  propose_learning_item_relearn: '810d7684325138b1309c7952db3c8cf9a29f59bb882e02cfd12d5fdcb38eaadd',
  propose_learning_item_defer: 'd2264b4eb707e7501beb6846766e1de2e8ac7489d4536c3ed14f7817efc2b616',
  propose_learning_item_archive: '82242132dbd7bbf38c06a97203837bb6e06f024e4f8ff097bf0543c3777861f3',
} as const;

const AGENCY_TOOL_EXPOSURES = {
  get_learning_item_context: [
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'coach',
    'maintenance',
  ],
  propose_learning_item_completion: [
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'coach',
    'maintenance',
  ],
  propose_learning_item_relearn: [
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'coach',
    'maintenance',
  ],
  propose_learning_item_defer: [
    'copilot',
    'copilot_user_suggested_mistake_action',
    'coach',
    'maintenance',
  ],
  propose_learning_item_archive: [
    'copilot',
    'copilot_user_suggested_mistake_action',
    'coach',
    'maintenance',
  ],
} as const;

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

describe('Agency tool and proposal lifecycle ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('moves learning-item tools out of mixed central modules', () => {
    const readerPath = 'src/capabilities/agency/server/tools/learning-item-context.ts';
    const proposalsPath = 'src/capabilities/agency/server/tools/proposal-tools.ts';
    expect(existsSync(join(process.cwd(), readerPath))).toBe(true);
    expect(existsSync(join(process.cwd(), proposalsPath))).toBe(true);

    const centralReaders = source('src/server/ai/tools/context-readers.ts');
    expect(centralReaders).not.toContain('export const getLearningItemContextTool');
    const centralProposals = source('src/server/ai/tools/proposal-tools.ts');
    for (const exportName of [
      'proposeLearningItemCompletionTool',
      'proposeLearningItemRelearnTool',
      'proposeLearningItemDeferTool',
      'proposeLearningItemArchiveTool',
    ]) {
      expect(centralProposals).not.toContain(`export const ${exportName}`);
    }

    const manifest = source('src/capabilities/agency/manifest.ts');
    expect(manifest).not.toContain('@/server/ai/tools/context-readers');
    expect(manifest).not.toContain('@/server/ai/tools/proposal-tools');
  });

  it('keeps the Agency reader free of hidden writes', () => {
    const reader = source('src/capabilities/agency/server/tools/learning-item-context.ts');
    expect(reader).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(reader).not.toMatch(/\bwrite(?:AiProposal|JobEvent|SessionEvent)\s*\(/);
  });

  it('loads unchanged names, schemas, effects, and allowlist exposure from Agency', async () => {
    expect(agencyCapability.copilotTools?.tools.map((tool) => tool.name)).toEqual(
      AGENCY_TOOL_NAMES,
    );
    await registerCapabilityTools([agencyCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS];
    for (const name of AGENCY_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing Agency tool: ${name}`);
      expect(contractFingerprint(tool), name).toBe(AGENCY_TOOL_CONTRACT_HASHES[name]);
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      expect(
        Object.entries(DOMAIN_TOOL_ALLOWLISTS)
          .filter(([, names]) => names.some((allowedName) => allowedName === name))
          .map(([surface]) => surface),
      ).toEqual(AGENCY_TOOL_EXPOSURES[name]);
    }
  });

  it('declares all lifecycle operations for reversible Agency proposal kinds', () => {
    const declarations = new Map(
      agencyCapability.proposals?.kinds.map((declaration) => [declaration.kind, declaration]),
    );
    for (const kind of ['learning_item', 'completion', 'relearn', 'goal_scope']) {
      const declaration = declarations.get(kind);
      expect(declaration?.accept?.load, `${kind} accept`).toBeTypeOf('function');
      expect(declaration?.dismiss?.load, `${kind} dismiss`).toBeTypeOf('function');
      expect(declaration?.retract?.load, `${kind} retract`).toBeTypeOf('function');
    }
    for (const kind of ['defer', 'conjecture']) {
      expect(declarations.get(kind)?.dismiss?.load, `${kind} dismiss`).toBeTypeOf('function');
    }
  });

  it('removes Agency-specific runtime wiring from central proposal actions', () => {
    const centralAccept = source('src/server/proposals/accept-action.ts');
    expect(centralAccept).not.toContain('createLearningIntentKnowledgeNode');
    expect(centralAccept).not.toContain('createLearningIntentNote');
    expect(centralAccept).not.toContain('enqueueLearningIntentNote');
    expect(source('src/server/proposals/action-types.ts')).not.toContain(
      "from '@/capabilities/agency/public'",
    );
  });
});
