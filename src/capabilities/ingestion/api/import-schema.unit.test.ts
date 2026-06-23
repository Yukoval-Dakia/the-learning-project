// YUK-234 (SEC-4) — unit coverage for the import request-body bounds.
//
// Pure Zod parse, no DB / R2 / AI — lives in the unit partition (registered in
// vitest.shared.ts fastTestInclude). Exercises the per-array `.max()` ceilings
// added in schema.ts plus the pre-existing semantics that must survive the
// extraction (min(1) blocks, page_spans min(1), the unanswered superRefine).

import { describe, expect, it } from 'vitest';

import { ImportBody, type ImportBodyInput } from './import-schema';

function validBlock(overrides: Partial<ImportBodyInput['blocks'][number]> = {}) {
  return {
    block_id: 'block_a',
    source_block_ids: ['block_a'],
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    image_refs: ['asset_a'],
    final_prompt_md: 'What is 2 + 2?',
    final_reference_md: '4',
    final_wrong_answer_md: '5',
    outcome: 'failure' as const,
    knowledge_ids: ['k_a'],
    cause: null,
    difficulty: 3,
    question_kind: 'short_answer' as const,
    ...overrides,
  };
}

function strings(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i}`);
}

describe('ImportBody bounds (YUK-234)', () => {
  it('accepts a minimal valid body', () => {
    const result = ImportBody.safeParse({ blocks: [validBlock()] });
    expect(result.success).toBe(true);
  });

  it('rejects an empty blocks array (min 1 preserved)', () => {
    const result = ImportBody.safeParse({ blocks: [] });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 200 blocks (boundary)', () => {
    const blocks = Array.from({ length: 200 }, () => validBlock());
    const result = ImportBody.safeParse({ blocks });
    expect(result.success).toBe(true);
  });

  it('rejects 201 blocks (over the .max(200) ceiling)', () => {
    const blocks = Array.from({ length: 201 }, () => validBlock());
    const result = ImportBody.safeParse({ blocks });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'blocks')).toBe(true);
    }
  });

  it('rejects > 200 source_block_ids on a block', () => {
    const block = validBlock({
      block_id: undefined,
      source_block_ids: strings(201, 'sb'),
    });
    const result = ImportBody.safeParse({ blocks: [block] });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 100 page_spans, rejects 101', () => {
    const span = { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } };
    const ok = ImportBody.safeParse({
      blocks: [validBlock({ page_spans: Array.from({ length: 100 }, () => span) })],
    });
    expect(ok.success).toBe(true);

    const over = ImportBody.safeParse({
      blocks: [validBlock({ page_spans: Array.from({ length: 101 }, () => span) })],
    });
    expect(over.success).toBe(false);
  });

  it('rejects an empty page_spans array (min 1 preserved)', () => {
    const result = ImportBody.safeParse({ blocks: [validBlock({ page_spans: [] })] });
    expect(result.success).toBe(false);
  });

  it('rejects > 100 image_refs on a block', () => {
    const result = ImportBody.safeParse({
      blocks: [validBlock({ image_refs: strings(101, 'asset') })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects > 100 knowledge_ids on a block', () => {
    const result = ImportBody.safeParse({
      blocks: [validBlock({ knowledge_ids: strings(101, 'k') })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty knowledge_ids array (min 1 preserved)', () => {
    const result = ImportBody.safeParse({ blocks: [validBlock({ knowledge_ids: [] })] });
    expect(result.success).toBe(false);
  });

  it('keeps the unanswered superRefine: empty answer ok only for outcome=unanswered', () => {
    const unanswered = ImportBody.safeParse({
      blocks: [validBlock({ outcome: 'unanswered', final_wrong_answer_md: '' })],
    });
    expect(unanswered.success).toBe(true);

    const failureEmpty = ImportBody.safeParse({
      blocks: [validBlock({ outcome: 'failure', final_wrong_answer_md: '' })],
    });
    expect(failureEmpty.success).toBe(false);
  });
});
