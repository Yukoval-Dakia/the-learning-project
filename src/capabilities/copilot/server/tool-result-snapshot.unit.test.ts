import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';
import * as registry from '@/server/ai/tools/registry';
import { CopilotToolResultSnapshotSchema } from '../primary-view-contract';
import {
  buildCopilotToolResultSnapshot,
  requiresToolResultLearningValidation,
} from './tool-result-snapshot';

// Seam tests; the DB companion validates the real registered output contracts.
function schema(outputSchema: z.ZodType) {
  vi.spyOn(registry, 'getTool').mockReturnValue({ outputSchema } as DomainTool<unknown, unknown>);
}
afterEach(() => vi.restoreAllMocks());
describe('bounded public result projection', () => {
  it('uses the owner schema, preserves falsy values and does not echo private property names', () => {
    schema(
      z.object({
        nodes: z.array(
          z.object({
            name: z.string(),
            score: z.number(),
            evidence: z.null(),
            approved: z.boolean(),
            children: z.array(z.string()),
            optional: z.string().optional(),
          }),
        ),
      }),
    );
    const output = {
      nodes: [
        {
          name: '函数',
          score: 0,
          evidence: null,
          approved: false,
          children: [],
          optional: undefined,
          'secret-in-key': 'private',
        },
      ],
    };
    const snapshot = buildCopilotToolResultSnapshot('query_knowledge', output);
    expect(snapshot).toMatchObject({
      state: 'available',
      value: { nodes: [{ name: '函数', score: 0, evidence: null, approved: false, children: [] }] },
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-in-key');
    output.nodes[0].name = 'changed';
    expect(JSON.stringify(snapshot)).toContain('函数');
    expect(CopilotToolResultSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('bounds several collections together and keeps their original coverage explicit', () => {
    schema(
      z.object({
        events: z.array(z.object({ text: z.string() })),
        rows: z.array(z.object({ text: z.string() })),
        total: z.number(),
        coverage: z.object({ has_more: z.boolean().nullable() }),
      }),
    );
    const rows = Array.from({ length: 300 }, () => ({ text: '中文资料。'.repeat(15) }));
    const snapshot = buildCopilotToolResultSnapshot('query_records', {
      events: rows,
      rows,
      total: 600,
      coverage: { has_more: null },
    });
    expect(snapshot).toMatchObject({
      state: 'available',
      completeness: 'projected',
      value: { total: 600, coverage: { has_more: null } },
    });
    if (snapshot.state !== 'available') throw new Error('expected bounded collections');
    expect(snapshot.byte_length).toBeLessThanOrEqual(32_000);
    const value = snapshot.value as { events: unknown[]; rows: unknown[] };
    expect(
      value.events.length +
        value.rows.length +
        snapshot.omissions.reduce(
          (n, x) => n + (x.reason === 'display_limit' ? (x.omitted_count ?? 0) : 0),
          0,
        ),
    ).toBe(600);
  });

  it('does not truncate generated content into a misleading successful fragment', () => {
    schema(z.object({ text: z.string(), cost_usd: z.number().nullable() }));
    expect(
      buildCopilotToolResultSnapshot('generate_question_candidate', {
        text: '求解 x，说明定义域。',
        cost_usd: null,
      }),
    ).toMatchObject({
      state: 'available',
      value: { text: '求解 x，说明定义域。' },
      completeness: 'projected',
    });
    expect(
      buildCopilotToolResultSnapshot('generate_question_candidate', {
        text: '界'.repeat(12_000),
        cost_usd: 0,
      }),
    ).toMatchObject({ state: 'unavailable', reason: 'size_limit' });
    expect(requiresToolResultLearningValidation('mcp__loom__generate_question_candidate')).toBe(
      true,
    );
    expect(requiresToolResultLearningValidation('query_knowledge')).toBe(false);
  });

  it('fails closed on invalid, unknown, unregistered and internal observations', () => {
    schema(z.object({ items: z.array(z.string()) }));
    expect(buildCopilotToolResultSnapshot('query_questions', { items: 'invalid' })).toMatchObject({
      state: 'unavailable',
    });
    expect(buildCopilotToolResultSnapshot('new_tool', { items: [] })).toMatchObject({
      reason: 'unsupported_result',
    });
    expect(buildCopilotToolResultSnapshot('write_agent_note', {})).toMatchObject({
      reason: 'internal_only',
    });
    vi.mocked(registry.getTool).mockReturnValue(undefined);
    expect(buildCopilotToolResultSnapshot('query_questions', { items: [] })).toMatchObject({
      reason: 'unsupported_result',
    });
  });
});
