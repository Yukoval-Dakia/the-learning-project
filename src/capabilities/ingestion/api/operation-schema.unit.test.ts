import { describe, expect, it } from 'vitest';

import { IngestionOperationRequest } from './operation-schema';

describe('IngestionOperationRequest', () => {
  it('accepts the four operation resource kinds', () => {
    expect(IngestionOperationRequest.parse({ kind: 'extract' })).toEqual({ kind: 'extract' });
    expect(IngestionOperationRequest.parse({ kind: 'make_paper' })).toEqual({
      kind: 'make_paper',
      input: {},
    });
    expect(
      IngestionOperationRequest.parse({
        kind: 'rescue',
        input: { block_id: 'b1', page: 0, tier: 2 },
      }),
    ).toMatchObject({ kind: 'rescue' });
    expect(
      IngestionOperationRequest.parse({
        kind: 'import',
        input: {
          blocks: [
            {
              source_block_ids: ['b1'],
              page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
              image_refs: [],
              final_prompt_md: '题目',
              final_reference_md: null,
              final_wrong_answer_md: '错答',
              knowledge_ids: ['k1'],
              cause: null,
              question_kind: 'choice',
            },
          ],
        },
      }),
    ).toMatchObject({ kind: 'import' });
  });

  it('rejects unknown operations and invalid nested input', () => {
    expect(IngestionOperationRequest.safeParse({ kind: 'revert' }).success).toBe(false);
    expect(
      IngestionOperationRequest.safeParse({
        kind: 'make_paper',
        input: { question_ids: [] },
      }).success,
    ).toBe(false);
    expect(
      IngestionOperationRequest.safeParse({
        kind: 'rescue',
        input: { block_id: '', page: -1, tier: 1 },
      }).success,
    ).toBe(false);
  });
});
