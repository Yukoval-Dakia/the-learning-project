// YUK-195 — DB-partition tests for the 6 question structure-edit DomainTools.
//
// Covers: registry (all 6 registered + summarized), and per-tool written +
// skipped:* soft-failure branches against a real Postgres testcontainer.
// Design note: docs/superpowers/specs/2026-06-01-question-edit-domaintools-design.md
// allow: SIZE_OK — one inherited DB contract matrix keeps shared fixtures and cross-tool parity.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { idHasMatch } from '@/capabilities/ingestion/server/block-structured-edit';
import {
  type FigureRefT,
  StructuredQuestion,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import { job_events, question_block } from '@/db/schema';
import { __resetRegistryForTests } from '@/server/ai/tools/registry';
import { gatherAndFoldQuestionBlock } from '@/server/projections/gather';
import { questionBlockLiveRowToSnapshot } from '@/server/projections/parity';
import { backfillQuestionBlockGenesis } from '../../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { addOptionTool, splitStemTool } from './question-block-node-edits';
import { mergeQuestionsTool, reassignFigureTool } from './question-block-structural-edits';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_yuk195',
    callerActor: { kind: 'agent', ref: 'agent:ingestion_block_edit' },
  };
}

interface SeedOpts {
  prepareHistory?: boolean;
  status?: string;
  structured?: StructuredQuestionT | null;
  figures?: FigureRefT[];
  sessionId?: string;
}

async function seedBlock(opts: SeedOpts = {}): Promise<{ blockId: string; sessionId: string }> {
  const db = testDb();
  const blockId = createId();
  const sessionId = opts.sessionId ?? createId();
  const now = new Date();
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: null,
    source_asset_ids: [],
    page_spans: [],
    structured: opts.structured ?? null,
    figures: opts.figures ?? [],
    layout_quality: 'structured',
    image_refs: [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: opts.status ?? 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  if (opts.prepareHistory !== false) await backfillQuestionBlockGenesis(db, now);
  return { blockId, sessionId };
}

async function readBlock(blockId: string) {
  const rows = await testDb().select().from(question_block).where(eq(question_block.id, blockId));
  return rows[0];
}

async function countEditEvents(blockId: string): Promise<number> {
  const rows = await testDb().select().from(job_events).where(eq(job_events.business_id, blockId));
  return rows.length;
}

beforeEach(async () => {
  await resetDb();
  __resetRegistryForTests();
});

// ---------------------------------------------------------------------------
// add_option (§4.2)
// ---------------------------------------------------------------------------

describe('add_option', () => {
  it('serializes concurrent option edits without losing either write', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'n1', role: 'standalone', prompt_text: 'q' },
    });

    await Promise.all([
      addOptionTool.execute(ctx(), {
        block_id: blockId,
        node_id: 'n1',
        option: { label: 'A', text: 'first' },
      }),
      addOptionTool.execute(ctx(), {
        block_id: blockId,
        node_id: 'n1',
        option: { label: 'B', text: 'second' },
      }),
    ]);

    const block = await readBlock(blockId);
    expect(block.structured?.options?.map((option) => option.label).sort()).toEqual(['A', 'B']);
    expect(block.version).toBe(2);
    expect(await countEditEvents(blockId)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// split_stem (§4.4)
// ---------------------------------------------------------------------------

describe('split_stem', () => {
  it('reattaches a nested-stem figure to the first promoted child (no dangling)', async () => {
    // Root stem holds a nested stem `inner` (with subs); a figure is attached to
    // `inner`. Splitting `inner` removes its id, so the figure must be
    // re-pointed onto the first promoted child rather than dangling.
    const { blockId } = await seedBlock({
      structured: {
        id: 'root',
        role: 'stem',
        prompt_text: 'root passage',
        sub_questions: [
          {
            id: 'inner',
            role: 'stem',
            prompt_text: 'inner passage',
            sub_questions: [
              { id: 'inner-a', role: 'sub', prompt_text: 'a' },
              { id: 'inner-b', role: 'sub', prompt_text: 'b' },
            ],
          },
        ],
      },
      figures: [
        {
          asset_id: 'fig-inner',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          attached_to_index: 'inner',
          attach_confidence: 'high',
        },
      ],
    });

    const out = await splitStemTool.execute(ctx(), { block_id: blockId, node_id: 'inner' });
    expect(out.status).toBe('written');

    const block = await readBlock(blockId);
    const tree = StructuredQuestion.parse(block.structured);
    // `inner` is gone; its children are promoted as standalone siblings.
    expect(idHasMatch(tree, 'inner')).toBe(false);
    expect(idHasMatch(tree, 'inner-a')).toBe(true);

    const fig = block.figures.find((figure) => figure.asset_id === 'fig-inner');
    expect(fig).toBeDefined();
    if (!fig) throw new TypeError('expected carried figure');
    // Re-pointed to the first promoted child, and it resolves in the tree.
    expect(fig?.attached_to_index).toBe('inner-a');
    expect(idHasMatch(tree, fig.attached_to_index)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// merge_questions (§4.5)
// ---------------------------------------------------------------------------

describe('merge_questions', () => {
  it('rejects an unprepared secondary and rolls back every block and transport event', async () => {
    const { blockId: primary, sessionId } = await seedBlock({
      structured: { id: 'p', role: 'standalone', prompt_text: '保留原问题' },
    });
    const { blockId: secondary } = await seedBlock({
      sessionId,
      prepareHistory: false,
      structured: { id: 's', role: 'standalone', prompt_text: '保留次问题和条件' },
    });
    const before = await Promise.all([readBlock(primary), readBlock(secondary)]);
    await expect(
      mergeQuestionsTool.execute(ctx(), {
        primary_block_id: primary,
        merge_block_ids: [secondary],
      }),
    ).rejects.toThrow('requires complete history');
    expect(await Promise.all([readBlock(primary), readBlock(secondary)])).toEqual(before);
    expect(await countEditEvents(primary)).toBe(0);
    expect(await countEditEvents(secondary)).toBe(0);
  });
  it('absorbs sibling blocks, marks them ignored, records merged_from_block_ids', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
    });
    const { blockId: m2 } = await seedBlock({
      sessionId,
      structured: { id: 'm2', role: 'standalone', prompt_text: 'merge2' },
    });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1, m2],
    });
    expect(out.status).toBe('written');

    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('stem');
    const subIds = primaryBlock.structured?.sub_questions?.map((s) => s.id) ?? [];
    // primary's own node first, then absorbed nodes in caller-supplied order.
    expect(subIds).toEqual(['p', 'm1', 'm2']);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1, m2]);
    expect(primaryBlock.version).toBe(1);

    expect((await readBlock(m1)).status).toBe('ignored');
    expect((await readBlock(m2)).status).toBe('ignored');
    for (const id of [primary, m1, m2]) {
      expect(await gatherAndFoldQuestionBlock(testDb(), id)).toEqual(
        questionBlockLiveRowToSnapshot(await readBlock(id)),
      );
    }
  });

  it("preserves a stem primary's existing sub_questions when absorbing more", async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: {
        id: 'p',
        role: 'stem',
        prompt_text: 'passage',
        sub_questions: [
          { id: 'p-a', role: 'sub', prompt_text: 'pa', source: 'tencent_ocr' },
          { id: 'p-b', role: 'sub', prompt_text: 'pb', source: 'tencent_ocr' },
        ],
      },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
    });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1],
    });
    expect(out.status).toBe('written');

    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('stem');
    // The stem primary's own passage is kept (not blanked) and its existing
    // sub_questions stay ahead of the absorbed node, in order.
    expect(primaryBlock.structured?.prompt_text).toBe('passage');
    const subIds = primaryBlock.structured?.sub_questions?.map((s) => s.id) ?? [];
    expect(subIds).toEqual(['p-a', 'p-b', 'm1']);
    // existingSubs branch: the primary's own subs are passed through untouched
    // (only the absorbed top node is stamped agent_edit).
    const existing = primaryBlock.structured?.sub_questions?.filter((s) => s.id !== 'm1') ?? [];
    expect(existing.map((s) => s.source)).toEqual(['tencent_ocr', 'tencent_ocr']);
    const absorbed = primaryBlock.structured?.sub_questions?.find((s) => s.id === 'm1');
    expect(absorbed?.source).toBe('agent_edit');
  });

  it('absorbs in caller-supplied order, not unordered SELECT order', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
    });
    const { blockId: m2 } = await seedBlock({
      sessionId,
      structured: { id: 'm2', role: 'standalone', prompt_text: 'merge2' },
    });
    // m1 seeded before m2, but request order is [m2, m1] → absorbed must follow
    // the request, not DB row order (the inArray SELECT is unordered).
    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m2, m1],
    });
    expect(out.status).toBe('written');
    const primaryBlock = await readBlock(primary);
    const subIds = primaryBlock.structured?.sub_questions?.map((s) => s.id) ?? [];
    expect(subIds).toEqual(['p', 'm2', 'm1']);
    expect(primaryBlock.merged_from_block_ids).toEqual([m2, m1]);
  });

  it('dedupes merge_block_ids and drops the primary id', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
    });
    // Duplicate m1 + the primary id itself must collapse to a single m1 merge —
    // not trip the length check and not write duplicate merged_from_block_ids.
    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1, m1, primary],
    });
    expect(out.status).toBe('written');
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1]);
    const subIds = primaryBlock.structured?.sub_questions?.map((s) => s.id) ?? [];
    expect(subIds).toEqual(['p', 'm1']);
    expect((await readBlock(m1)).status).toBe('ignored');
  });

  it('skips cross_session when a merge block belongs to another session', async () => {
    const { blockId: primary } = await seedBlock({
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: other } = await seedBlock({
      structured: { id: 'o', role: 'standalone', prompt_text: 'other' },
    });
    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [other],
    });
    expect(out.status).toBe('skipped:cross_session');
    expect((await readBlock(other)).status).toBe('draft');
  });

  it('skips not_draft when primary is not draft', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      status: 'imported',
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'm' },
    });
    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1],
    });
    expect(out.status).toBe('skipped:not_draft');
  });

  it('preserves a merged block whose root is a stem (role + sub_questions intact)', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: {
        id: 'stem-m1',
        role: 'stem',
        prompt_text: 'passage',
        sub_questions: [
          { id: 'm1-a', role: 'sub', prompt_text: 'alpha' },
          { id: 'm1-b', role: 'sub', prompt_text: 'beta' },
        ],
      },
    });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1],
    });
    expect(out.status).toBe('written');

    const primaryBlock = await readBlock(primary);
    const tree = StructuredQuestion.parse(primaryBlock.structured);
    // The absorbed stem stays a nested stem (NOT flattened to a leaf 'sub').
    const absorbedStem = tree.sub_questions?.find((s) => s.id === 'stem-m1');
    expect(absorbedStem).toBeDefined();
    expect(absorbedStem?.role).toBe('stem');
    expect(absorbedStem?.sub_questions?.map((s) => s.id)).toEqual(['m1-a', 'm1-b']);
    // Provenance stamped on the absorbed top node only.
    expect(absorbedStem?.last_modified_by).toBe('agent:ingestion_block_edit');

    // Merged tree is schema-legal (refine does not reject the nested stem).
    expect(() => StructuredQuestion.parse(tree)).not.toThrow();
    // Derived markdown recurses into the nested stem's subs (not silently lost).
    const md = structuredToPromptMarkdown(tree);
    expect(md).toContain('alpha');
    expect(md).toContain('beta');
  });

  it('carries the merged blocks figures onto the primary (union, ids resolve)', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const mergeFigure: FigureRefT = {
      asset_id: 'fig-m1',
      role: 'diagram',
      source_page_index: 0,
      source_bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      attached_to_index: 'm1',
      attach_confidence: 'high',
    };
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
      figures: [mergeFigure],
    });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1],
    });
    expect(out.status).toBe('written');

    const primaryBlock = await readBlock(primary);
    // The merge block's figure is now on the primary.
    const carried = primaryBlock.figures.find((figure) => figure.asset_id === 'fig-m1');
    expect(carried).toBeDefined();
    if (!carried) throw new TypeError('expected merged figure');
    // Its attached_to_index still resolves inside the merged tree.
    const tree = StructuredQuestion.parse(primaryBlock.structured);
    expect(idHasMatch(tree, carried.attached_to_index)).toBe(true);
  });

  it('skips null_structured when a merge block has null structured (no mutation)', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({
      sessionId,
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const { blockId: m1 } = await seedBlock({ sessionId, structured: null });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1],
    });
    expect(out.status).toBe('skipped:null_structured');

    // No mutation: primary unchanged (still its own standalone), merge still draft.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.id).toBe('p');
    expect(primaryBlock.structured?.role).toBe('standalone');
    expect(primaryBlock.merged_from_block_ids).toEqual([]);
    expect(primaryBlock.version).toBe(0);
    expect((await readBlock(m1)).status).toBe('draft');
  });

  it('skips null_structured when the primary has null structured (no mutation)', async () => {
    const sessionId = createId();
    const { blockId: primary } = await seedBlock({ sessionId, structured: null });
    const { blockId: m1 } = await seedBlock({
      sessionId,
      structured: { id: 'm1', role: 'standalone', prompt_text: 'merge1' },
    });

    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [m1],
    });
    expect(out.status).toBe('skipped:null_structured');

    expect((await readBlock(primary)).structured).toBeNull();
    expect((await readBlock(m1)).status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// reassign_figure (§4.6)
// ---------------------------------------------------------------------------

const FIGURE: FigureRefT = {
  asset_id: 'fig-1',
  role: 'diagram',
  source_page_index: 0,
  source_bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
  attached_to_index: 's1',
  attach_confidence: 'high',
};

describe('reassign_figure', () => {
  it('rejects unprepared history without changing figure state or publishing transport events', async () => {
    const { blockId } = await seedBlock({
      prepareHistory: false,
      figures: [FIGURE],
      structured: { id: 's1', role: 'standalone', prompt_text: '解释图中的条件关系' },
    });
    const before = await readBlock(blockId);
    await expect(
      reassignFigureTool.execute(ctx(), {
        block_id: blockId,
        asset_id: 'fig-1',
        attached_to_index: 's1',
      }),
    ).rejects.toThrow('requires complete history');
    expect(await readBlock(blockId)).toEqual(before);
    expect(await countEditEvents(blockId)).toBe(0);
  });
});
