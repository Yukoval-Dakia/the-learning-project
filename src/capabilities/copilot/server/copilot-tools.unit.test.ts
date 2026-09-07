import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { capabilities } from '@/capabilities';
import { copilotCapability } from '@/capabilities/copilot/manifest';
import {
  CONTROL_TOOLS,
  COPILOT_TOOLS,
  DOMAIN_TOOL_ALLOWLISTS,
  PROPOSE_WRITE_TOOLS,
  READ_TOOLS,
} from '@/kernel/tools/allowlists';
import type { DomainTool } from '@/kernel/tools/types';

const COPILOT_OWNED_TOOL_NAMES = [
  'present_primary_view',
  'query_events',
  'search_memory_facts',
] as const;

const LEGACY_MODEL_CONTROL_NAMES = [
  'get_tool_operation',
  'wait_tool_operation',
  'cancel_tool_operation',
  'launch_researcher',
  'get_subagent',
  'wait_subagent',
  'cancel_subagent',
] as const;

const OWNED_TOOL_EXPOSURES = {
  present_primary_view: ['copilot', 'copilot_user_suggested_mistake_action'],
  query_events: [
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'maintenance',
    'ingestion_block_edit',
  ],
  search_memory_facts: ['copilot', 'copilot_user_suggested_mistake_action', 'dreaming', 'coach'],
} as const;

const OWNED_READER_PATHS = [
  'src/capabilities/copilot/server/tools/query-events.ts',
  'src/capabilities/copilot/server/tools/search-memory-facts.ts',
  'src/kernel/read-models/question-activity.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

// 裁决 h：COPILOT_TOOLS 数组保持字面量（src/ai 浏览器共享面不能 import
// @/capabilities）；归属真相源 = 各包 manifest.copilotTools，本测试强制两面相等。
describe('copilotTools 贡献制 ↔ COPILOT_TOOLS allowlist 对账', () => {
  it('五包声明聚合覆盖完整 DomainTool inventory 且无重复', () => {
    const declared = capabilities.flatMap((c) => c.copilotTools?.tools.map((t) => t.name) ?? []);
    const fullInventory = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS, ...CONTROL_TOOLS];
    expect(new Set(declared)).toEqual(new Set(fullInventory));
    expect(declared).toHaveLength(fullInventory.length);
    expect(fullInventory).toHaveLength(42);
    for (const name of LEGACY_MODEL_CONTROL_NAMES) {
      expect(declared, name).not.toContain(name);
      expect(fullInventory, name).not.toContain(name);
    }
  });

  it('浏览器共享的 Copilot 字面 allowlist 是 manifest 完整 inventory 的精确子集', () => {
    const declared = new Set(
      capabilities.flatMap((c) => c.copilotTools?.tools.map((t) => t.name) ?? []),
    );
    expect(COPILOT_TOOLS.every((name) => declared.has(name))).toBe(true);
    expect(new Set(COPILOT_TOOLS).size).toBe(COPILOT_TOOLS.length);
    expect(COPILOT_TOOLS).toHaveLength(31);
    expect(COPILOT_TOOLS).toContain('author_question');
    expect(COPILOT_TOOLS).toEqual(
      expect.arrayContaining(['generate_goal_outline', 'generate_question_candidate']),
    );
    for (const name of LEGACY_MODEL_CONTROL_NAMES) {
      expect(COPILOT_TOOLS, name).not.toContain(name);
    }
  });
});

describe('copilot server ownership (YUK-884)', () => {
  it('exposes primary-view intent as an actual MCP-compatible control schema', async () => {
    const declaration = copilotCapability.copilotTools?.tools.find(
      (tool) => tool.name === 'present_primary_view',
    );
    const tool = (await declaration?.load?.()) as DomainTool<unknown, unknown> | undefined;
    expect(tool?.effect).toBe('control');
    expect(tool?.mirrorEvent).toBe('never');
    expect(tool?.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(
      tool?.inputSchema.safeParse({ source: 'artifact', ref: '<p>wrong carrier</p>' }).success,
    ).toBe(false);
  });

  it('exposes Copilot event readers through the public capability seam', () => {
    const publicPort = source('src/capabilities/copilot/public.ts');
    for (const name of [
      'getRecentReviewEvents',
      'getQuestionTimeline',
      'getQuestionAttemptOutcomeCounts',
    ]) {
      expect(publicPort).toContain(name);
    }
    expect(publicPort).toContain('QuestionTimelineEntry');
  });

  it('loads the owned tools and preserves every permission surface', async () => {
    const declarations = copilotCapability.copilotTools?.tools ?? [];
    const fullAllowlist = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS, ...CONTROL_TOOLS];

    for (const name of COPILOT_OWNED_TOOL_NAMES) {
      const matches = declarations.filter((declaration) => declaration.name === name);
      expect(matches).toHaveLength(1);
      const tool = await matches[0]?.load?.();
      expect(tool?.name).toBe(name);
      expect(fullAllowlist.some((allowedName) => allowedName === name)).toBe(true);
      expect(
        Object.entries(DOMAIN_TOOL_ALLOWLISTS)
          .filter(([, names]) => names.some((allowedName) => allowedName === name))
          .map(([surface]) => surface),
      ).toEqual(OWNED_TOOL_EXPOSURES[name]);
      // Migration-time schema hashes are retired. Runtime contract tests cover
      // accepted/rejected values; this test owns composition and permissions.
    }
  });

  it('keeps capability-owned public readers free of hidden writes', () => {
    for (const path of OWNED_READER_PATHS) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
      const reader = source(path);
      expect(reader, path).not.toMatch(/\b(?:ctx\.)?db\s*\.\s*(?:insert|update|delete)\s*\(/);
      expect(reader, path).not.toMatch(/\bwrite(?:Event|AiProposal|JobEvent|SessionEvent)\s*\(/);
    }
  });
});
