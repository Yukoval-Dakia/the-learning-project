import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';
import * as registry from '@/server/ai/tools/registry';
import { CopilotToolResultSnapshotSchema } from '../primary-view-contract';
import { buildCopilotToolResultSnapshot } from './tool-result-snapshot';

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
});
