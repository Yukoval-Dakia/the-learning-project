// YUK-195 — DB-partition tests for the 6 question structure-edit DomainTools.
//
// Covers: registry (all 6 registered + summarized), and per-tool written +
// skipped:* soft-failure branches against a real Postgres testcontainer.
// Design note: docs/superpowers/specs/2026-06-01-question-edit-domaintools-design.md

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { idHasMatch } from '@/capabilities/ingestion/server/block-structured-edit';
import {
  StructuredQuestion,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import { job_events, question_block } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import {
  addOptionTool,
  mergeQuestionsTool,
  reassignFigureTool,
  setQuestionTypeTool,
  splitStemTool,
  updatePromptTool,
} from './question-edit-tools';
import { __resetRegistryForTests, getTool } from './registry';
import type { ToolContext } from './types';

const EDIT_TOOL_NAMES = [
  'update_prompt',
  'add_option',
  'set_question_type',
  'split_stem',
  'merge_questions',
  'reassign_figure',
] as const;

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_yuk195',
    callerActor: { kind: 'agent', ref: 'agent:ingestion_block_edit' },
  };
}

interface SeedOpts {
  status?: string;
  structured?: StructuredQuestionT | null;
  // biome-ignore lint/suspicious/noExplicitAny: tests pass arbitrary jsonb figure shapes
  figures?: any[];
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
  __resetBootstrapForTests();
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('question-edit-tools registry', () => {
  it('registers all 6 structure-edit tools as write/local/when_causal', () => {
    registerCoreTools();
    for (const name of EDIT_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, `tool ${name} registered`).toBeDefined();
      expect(tool?.effect).toBe('write');
      expect(tool?.costClass).toBe('local');
      expect(tool?.mirrorEvent).toBe('when_causal');
    }
  });

  it('each tool summarize() returns a non-empty string under ~120 chars', () => {
    const samples: Array<[(typeof EDIT_TOOL_NAMES)[number], unknown, unknown]> = [
      ['update_prompt', { block_id: 'b', node_id: 'n12345678' }, { status: 'written' }],
      [
        'add_option',
        { block_id: 'b', node_id: 'n12345678', option: { label: 'A', text: 't' } },
        { status: 'written' },
      ],
      [
        'set_question_type',
        { block_id: 'b', node_id: 'n12345678', kind: 'choice' },
        { status: 'written' },
      ],
      ['split_stem', { block_id: 'b', node_id: 'n12345678' }, { status: 'written' }],
      [
        'merge_questions',
        { primary_block_id: 'b', merge_block_ids: ['m1', 'm2'] },
        { status: 'written' },
      ],
      [
        'reassign_figure',
        { block_id: 'b', asset_id: 'a12345678', attached_to_index: 'n12345678' },
        { status: 'written' },
      ],
    ];
    registerCoreTools();
    for (const [name, input, output] of samples) {
      const tool = getTool(name);
      // biome-ignore lint/suspicious/noExplicitAny: cross-typed summarize sample
      const s = tool?.summarize(input as any, output as any) ?? '';
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(120);
    }
  });
});

// ---------------------------------------------------------------------------
// update_prompt (§4.1)
// ---------------------------------------------------------------------------

describe('update_prompt', () => {
  it('writes prompt_text + provenance + version bump + job event', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'n1', role: 'standalone', prompt_text: 'old' },
    });
    const out = await updatePromptTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'n1',
      prompt_text: 'new prompt',
    });
    expect(out).toEqual({ status: 'written', block_id: blockId, node_id: 'n1' });
    const block = await readBlock(blockId);
    expect(block.structured?.prompt_text).toBe('new prompt');
    expect(block.structured?.source).toBe('agent_edit');
    expect(block.structured?.last_modified_by).toBe('agent:ingestion_block_edit');
    expect(block.version).toBe(1);
    expect(await countEditEvents(blockId)).toBe(1);
  });

  it('skips when block is not draft', async () => {
    const { blockId } = await seedBlock({
      status: 'imported',
      structured: { id: 'n1', role: 'standalone', prompt_text: 'old' },
    });
    const out = await updatePromptTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'n1',
      prompt_text: 'x',
    });
    expect(out.status).toBe('skipped:not_draft');
    expect((await readBlock(blockId)).structured?.prompt_text).toBe('old');
  });

  it('skips when node is missing', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'n1', role: 'standalone', prompt_text: 'old' },
    });
    const out = await updatePromptTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'nope',
      prompt_text: 'x',
    });
    expect(out.status).toBe('skipped:node_not_found');
  });
});

// ---------------------------------------------------------------------------
// add_option (§4.2)
// ---------------------------------------------------------------------------

describe('add_option', () => {
  it('appends an option, creating the array when absent', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'n1', role: 'standalone', prompt_text: 'q' },
    });
    const out = await addOptionTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'n1',
      option: { label: 'A', text: 'first' },
    });
    expect(out.status).toBe('written');
    const block = await readBlock(blockId);
    expect(block.structured?.options).toEqual([{ label: 'A', text: 'first' }]);
    expect(block.version).toBe(1);
  });

  it('skips node_not_found', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'n1', role: 'standalone', prompt_text: 'q' },
    });
    const out = await addOptionTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'missing',
      option: { label: 'A', text: 'x' },
    });
    expect(out.status).toBe('skipped:node_not_found');
  });
});

// ---------------------------------------------------------------------------
// set_question_type (§4.3)
// ---------------------------------------------------------------------------

describe('set_question_type', () => {
  it('writes the advisory kind hint + provenance', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'n1', role: 'standalone', prompt_text: 'q' },
    });
    const out = await setQuestionTypeTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'n1',
      kind: 'choice',
    });
    expect(out.status).toBe('written');
    const block = await readBlock(blockId);
    expect(block.structured?.kind).toBe('choice');
    expect(block.structured?.source).toBe('agent_edit');
  });

  it('skips not_draft', async () => {
    const { blockId } = await seedBlock({
      status: 'ignored',
      structured: { id: 'n1', role: 'standalone', prompt_text: 'q' },
    });
    const out = await setQuestionTypeTool.execute(ctx(), {
      block_id: blockId,
      node_id: 'n1',
      kind: 'essay',
    });
    expect(out.status).toBe('skipped:not_draft');
  });
});

// ---------------------------------------------------------------------------
// split_stem (§4.4)
// ---------------------------------------------------------------------------

describe('split_stem', () => {
  it('un-groups a root stem: subs promoted to standalone, passage dropped', async () => {
    const { blockId } = await seedBlock({
      structured: {
        id: 'stem',
        role: 'stem',
        prompt_text: 'passage',
        sub_questions: [
          { id: 's1', role: 'sub', prompt_text: 'a' },
          { id: 's2', role: 'sub', prompt_text: 'b' },
        ],
      },
    });
    const out = await splitStemTool.execute(ctx(), { block_id: blockId, node_id: 'stem' });
    expect(out.status).toBe('written');
    const block = await readBlock(blockId);
    const tree = block.structured;
    expect(tree?.prompt_text).toBe('');
    expect(tree?.sub_questions?.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(tree?.sub_questions?.every((s) => s.role === 'standalone')).toBe(true);
    expect(tree?.sub_questions?.every((s) => s.source === 'agent_edit')).toBe(true);
    expect(block.version).toBe(1);
  });

  it('skips not_splittable when node is a standalone leaf', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'leaf', role: 'standalone', prompt_text: 'x' },
    });
    const out = await splitStemTool.execute(ctx(), { block_id: blockId, node_id: 'leaf' });
    expect(out.status).toBe('skipped:not_splittable');
  });

  it('skips node_not_found', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 'leaf', role: 'standalone', prompt_text: 'x' },
    });
    const out = await splitStemTool.execute(ctx(), { block_id: blockId, node_id: 'ghost' });
    expect(out.status).toBe('skipped:node_not_found');
  });

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
    const tree = block.structured as StructuredQuestionT;
    // `inner` is gone; its children are promoted as standalone siblings.
    expect(idHasMatch(tree, 'inner')).toBe(false);
    expect(idHasMatch(tree, 'inner-a')).toBe(true);

    const fig = block.figures.find((f: { asset_id: string }) => f.asset_id === 'fig-inner') as
      | { attached_to_index: string }
      | undefined;
    expect(fig).toBeDefined();
    // Re-pointed to the first promoted child, and it resolves in the tree.
    expect(fig?.attached_to_index).toBe('inner-a');
    expect(idHasMatch(tree, (fig as { attached_to_index: string }).attached_to_index)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// merge_questions (§4.5)
// ---------------------------------------------------------------------------

describe('merge_questions', () => {
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

  it('skips block_not_found when a merge block does not exist', async () => {
    const { blockId: primary } = await seedBlock({
      structured: { id: 'p', role: 'standalone', prompt_text: 'primary' },
    });
    const out = await mergeQuestionsTool.execute(ctx(), {
      primary_block_id: primary,
      merge_block_ids: [createId()],
    });
    expect(out.status).toBe('skipped:block_not_found');
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
    const tree = primaryBlock.structured as StructuredQuestionT;
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
    const mergeFigure = {
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
    const carried = primaryBlock.figures.find((f: { asset_id: string }) => f.asset_id === 'fig-m1');
    expect(carried).toBeDefined();
    // Its attached_to_index still resolves inside the merged tree.
    const tree = primaryBlock.structured as StructuredQuestionT;
    expect(idHasMatch(tree, (carried as { attached_to_index: string }).attached_to_index)).toBe(
      true,
    );
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

const FIGURE = {
  asset_id: 'fig-1',
  role: 'diagram',
  source_page_index: 0,
  source_bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
  attached_to_index: 's1',
  attach_confidence: 'high',
};

describe('reassign_figure', () => {
  it('reassigns a figure, sets manual confidence + version bump', async () => {
    const { blockId } = await seedBlock({
      structured: {
        id: 'stem',
        role: 'stem',
        prompt_text: '',
        sub_questions: [
          { id: 's1', role: 'sub', prompt_text: 'a' },
          { id: 's2', role: 'sub', prompt_text: 'b' },
        ],
      },
      figures: [FIGURE],
    });
    const out = await reassignFigureTool.execute(ctx(), {
      block_id: blockId,
      asset_id: 'fig-1',
      attached_to_index: 's2',
    });
    expect(out.status).toBe('written');
    const block = await readBlock(blockId);
    expect(block.figures[0].attached_to_index).toBe('s2');
    expect(block.figures[0].attach_confidence).toBe('manual');
    expect(block.version).toBe(1);
  });

  it('skips not_draft (agent tool enforces draft)', async () => {
    const { blockId } = await seedBlock({
      status: 'imported',
      structured: { id: 's1', role: 'standalone', prompt_text: 'a' },
      figures: [FIGURE],
    });
    const out = await reassignFigureTool.execute(ctx(), {
      block_id: blockId,
      asset_id: 'fig-1',
      attached_to_index: 's1',
    });
    expect(out.status).toBe('skipped:not_draft');
  });

  it('skips figure_not_found', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 's1', role: 'standalone', prompt_text: 'a' },
      figures: [],
    });
    const out = await reassignFigureTool.execute(ctx(), {
      block_id: blockId,
      asset_id: 'ghost',
      attached_to_index: 's1',
    });
    expect(out.status).toBe('skipped:figure_not_found');
  });

  it('skips target_not_found when attached_to_index is not in the tree', async () => {
    const { blockId } = await seedBlock({
      structured: { id: 's1', role: 'standalone', prompt_text: 'a' },
      figures: [{ ...FIGURE, attached_to_index: 's1' }],
    });
    const out = await reassignFigureTool.execute(ctx(), {
      block_id: blockId,
      asset_id: 'fig-1',
      attached_to_index: 'does-not-exist',
    });
    expect(out.status).toBe('skipped:target_not_found');
  });
});
