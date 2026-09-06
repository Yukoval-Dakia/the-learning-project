import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { agencyCapability } from '@/capabilities/agency/manifest';
import {
  CONTROL_TOOLS,
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
} from '@/kernel/tools/allowlists';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests, getTool } from '@/server/ai/tools/registry';

const AGENCY_TOOL_NAMES = [
  'get_learning_item_context',
  'propose_learning_item_completion',
  'propose_learning_item_relearn',
  'propose_learning_item_defer',
  'propose_learning_item_archive',
  'read_agent_notes',
  'write_agent_note',
] as const;

const AGENCY_TOOL_EFFECTS = {
  get_learning_item_context: 'read',
  propose_learning_item_completion: 'propose',
  propose_learning_item_relearn: 'propose',
  propose_learning_item_defer: 'propose',
  propose_learning_item_archive: 'propose',
  read_agent_notes: 'read',
  write_agent_note: 'write',
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
  read_agent_notes: ['copilot', 'copilot_user_suggested_mistake_action', 'dreaming', 'coach'],
  write_agent_note: ['copilot', 'copilot_user_suggested_mistake_action', 'dreaming', 'coach'],
} as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Agency tool and proposal lifecycle ownership', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('keeps the Agency reader free of hidden writes', () => {
    const reader = source('src/capabilities/agency/server/tools/learning-item-context.ts');
    expect(reader).not.toMatch(/\.(insert|update|delete)\s*\(/);
    expect(reader).not.toMatch(/\bwrite(?:AiProposal|JobEvent|SessionEvent)\s*\(/);
  });

  it('loads owned tools with the intended effects, costs and permissions', async () => {
    expect(agencyCapability.copilotTools?.tools.map((tool) => tool.name).sort()).toEqual(
      [...AGENCY_TOOL_NAMES, 'generate_goal_outline'].sort(),
    );
    await registerCapabilityTools([agencyCapability]);
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS, ...CONTROL_TOOLS];
    for (const name of AGENCY_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, name).toBeDefined();
      if (!tool) throw new Error(`missing Agency tool: ${name}`);
      expect(tool.name).toBe(name);
      expect(tool.effect).toBe(AGENCY_TOOL_EFFECTS[name]);
      expect(tool.costClass).toBe('local');
      expect(tool.mirrorEvent).toBe(
        name === 'get_learning_item_context' ? 'when_user_visible' : 'when_causal',
      );
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
