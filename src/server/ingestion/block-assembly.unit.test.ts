/**
 * YUK-227 S3 Slice A (F4) — block-assembly spatial projection unit tests.
 *
 * Tests the spatial upgrade to path-B projectBlock: when VLM-path blocks carry
 * real page_index values (non-zero), they are included in the projected input.
 * When ALL blocks carry placeholder page_index=0 (Tencent fallback), the spatial
 * signal is omitted and the model falls back to pure semantic reasoning.
 *
 * P2-1 fix: tests now call the EXPORTED production `projectBlock` directly
 * instead of reimplementing the projection logic internally. This ensures that
 * production bugs in projectBlock are caught by these tests (previously a
 * tautological reimplementation let the P1 bug escape).
 *
 * No DB — these tests only exercise pure functions and capture the LLM input via
 * an injected runTaskFn. No imports from tests/helpers/db / @/db/client / postgres
 * / drizzle / PgBoss (unit partition constraint).
 */
import { describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  type BlockAssemblyInputBlock,
  type BlockAssemblySourceBlock,
  isAllPlaceholderPageIndex,
  projectBlock,
  runBlockAssemblyTask,
} from './block-assembly';

// ---------- helpers ----------

function makeBlock(
  id: string,
  pageIndex: number,
  prompt = `prompt for ${id}`,
  questionNo: string | null = null,
): BlockAssemblySourceBlock {
  const structured: StructuredQuestionT = {
    id,
    role: 'standalone',
    prompt_text: prompt,
    ...(questionNo ? { question_no: questionNo } : {}),
  };
  return {
    id,
    structured,
    layout_quality: 'structured',
    page_spans: [{ page_index: pageIndex, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
  };
}

function makeBlockNoSpans(id: string): BlockAssemblySourceBlock {
  return {
    id,
    structured: { id, role: 'standalone', prompt_text: 'p' },
    layout_quality: 'structured',
  };
}

// ---------- isAllPlaceholderPageIndex ----------

describe('isAllPlaceholderPageIndex (YUK-227 S3 Slice A F4)', () => {
  it('returns true when all blocks have page_index=0 (placeholder)', () => {
    const blocks = [makeBlock('a', 0), makeBlock('b', 0), makeBlock('c', 0)];
    expect(isAllPlaceholderPageIndex(blocks)).toBe(true);
  });

  it('returns false when at least one block has page_index > 0 (real VLM signal)', () => {
    const blocks = [makeBlock('a', 0), makeBlock('b', 1), makeBlock('c', 0)];
    expect(isAllPlaceholderPageIndex(blocks)).toBe(false);
  });

  it('returns true when page_spans is absent (treated as placeholder)', () => {
    const blocks = [makeBlockNoSpans('x'), makeBlock('y', 0)];
    expect(isAllPlaceholderPageIndex(blocks)).toBe(true);
  });

  it('returns true for empty block list', () => {
    expect(isAllPlaceholderPageIndex([])).toBe(true);
  });

  it('returns false when a single block has page_index=2', () => {
    expect(isAllPlaceholderPageIndex([makeBlock('a', 2)])).toBe(false);
  });
});

// ---------- projectBlock: direct production function tests (P2-1) ----------
//
// Tests call the EXPORTED `projectBlock` directly. This exercises the actual
// production isAllPlaceholderPageIndex → projectBlock chain and catches bugs
// that a tautological reimplementation would miss (see P2-1 fix note above).

describe('projectBlock (YUK-227 S3 Slice A F4)', () => {
  it('includes page_index when includeSpatial=true and block has page_spans', () => {
    const block = makeBlock('a', 1, 'prompt a', '1');
    const result = projectBlock(block, true);
    expect(result.block_id).toBe('a');
    expect(result.page_index).toBe(1);
    expect(result.question_no).toBe('1');
    expect(result.prompt_head).toBe('prompt a');
    expect(result.role).toBe('standalone');
    expect(result.layout_quality).toBe('structured');
  });

  it('includes page_index=0 when includeSpatial=true and block is on page 0', () => {
    const block = makeBlock('a', 0, 'prompt a', '1');
    const result = projectBlock(block, true);
    expect(result.page_index).toBe(0);
  });

  it('omits page_index when includeSpatial=false (placeholder/semantic-only mode)', () => {
    const block = makeBlock('a', 1, 'prompt a');
    const result = projectBlock(block, false);
    expect(result.page_index).toBeUndefined();
  });

  it('omits page_index when includeSpatial=true but block has no page_spans', () => {
    const block = makeBlockNoSpans('x');
    const result = projectBlock(block, true);
    expect(result.page_index).toBeUndefined();
  });

  it('semantic fields are always present regardless of spatial mode', () => {
    const block = makeBlock('q1', 2, '长题目文字', '5');
    const spatial = projectBlock(block, true);
    const semantic = projectBlock(block, false);

    for (const result of [spatial, semantic]) {
      expect(result.block_id).toBe('q1');
      expect(result.question_no).toBe('5');
      expect(result.prompt_head).toBe('长题目文字');
      expect(result.role).toBe('standalone');
      expect(result.layout_quality).toBe('structured');
      expect(result.sub_question_count).toBe(0);
    }
    // Only spatial mode includes page_index
    expect(spatial.page_index).toBe(2);
    expect(semantic.page_index).toBeUndefined();
  });

  it('truncates prompt_head to 400 chars', () => {
    const longPrompt = 'x'.repeat(500);
    const block = makeBlock('a', 0, longPrompt);
    const result = projectBlock(block, false);
    expect(result.prompt_head).toHaveLength(400);
  });
});

// ---------- projectBlock spatial signal via runBlockAssemblyTask ----------
//
// End-to-end verification: blocks with non-zero page_index → isAllPlaceholderPageIndex
// returns false → runBlockAssemblyForSession would pass includeSpatial=true →
// projectBlock emits page_index. We verify the full chain by building the
// input the same way runBlockAssemblyForSession does and confirming the task receives
// the right shape.

describe('projectBlock spatial signal (YUK-227 S3 Slice A F4)', () => {
  /**
   * Build input blocks via projectBlock (real production function) and pass them to
   * runBlockAssemblyTask, capturing what the model receives.
   */
  async function captureProjected(
    sourceBlocks: BlockAssemblySourceBlock[],
  ): Promise<BlockAssemblyInputBlock[]> {
    let captured: BlockAssemblyInputBlock[] = [];

    const includeSpatial = !isAllPlaceholderPageIndex(sourceBlocks);
    const projectedBlocks: BlockAssemblyInputBlock[] = sourceBlocks.map((b) =>
      projectBlock(b, includeSpatial),
    );

    await runBlockAssemblyTask({
      input: {
        ingestion_session_id: 'test-session',
        blocks: projectedBlocks,
      },
      runTaskFn: async (_kind, input) => {
        captured = (input as { blocks: BlockAssemblyInputBlock[] }).blocks;
        return { text: '{"candidates":[]}' };
      },
    });

    return captured;
  }

  it('includes page_index when blocks have real (non-zero) page indices', async () => {
    const sourceBlocks = [makeBlock('a', 0, 'prompt a', '1'), makeBlock('b', 1, 'prompt b', '2')];
    const projected = await captureProjected(sourceBlocks);
    expect(projected).toHaveLength(2);
    // At least one non-zero → both get page_index (includeSpatial=true)
    expect(projected[0].page_index).toBe(0);
    expect(projected[1].page_index).toBe(1);
  });

  it('omits page_index when ALL blocks carry placeholder page_index=0', async () => {
    const sourceBlocks = [makeBlock('a', 0, 'prompt a', '1'), makeBlock('b', 0, 'prompt b', '2')];
    const projected = await captureProjected(sourceBlocks);
    expect(projected).toHaveLength(2);
    // All-placeholder → page_index must be absent (semantic-only fallback).
    expect(projected[0].page_index).toBeUndefined();
    expect(projected[1].page_index).toBeUndefined();
  });

  it('omits page_index when blocks have no page_spans', async () => {
    const sourceBlocks = [makeBlockNoSpans('a'), makeBlockNoSpans('b')];
    const projected = await captureProjected(sourceBlocks);
    expect(projected[0].page_index).toBeUndefined();
    expect(projected[1].page_index).toBeUndefined();
  });

  it('semantic-only fields are always present regardless of spatial mode', async () => {
    const sourceBlocks = [makeBlock('q1', 0, '长题目文字', '5')];
    const projected = await captureProjected(sourceBlocks);
    expect(projected[0].block_id).toBe('q1');
    expect(projected[0].question_no).toBe('5');
    expect(projected[0].prompt_head).toBe('长题目文字');
    expect(projected[0].role).toBe('standalone');
    expect(projected[0].layout_quality).toBe('structured');
  });
});
