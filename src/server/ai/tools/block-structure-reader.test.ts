// ADR-0032 D6-draftread (YUK-203 lane L5) — DB-partition test for the ingestion
// draft-layer structure reader `get_question_block_structure`. Seeds a real
// question_block and asserts the addressable projection (read≡write coordinate
// fix). Routes to the db partition via src/**/*.test.ts (no fastTestInclude entry).

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import type { FigureRefT, StructuredQuestionT } from '@/core/schema/structured_question';
import { question_block } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import { getQuestionBlockStructureTool } from './context-readers';
import { __resetRegistryForTests, getTool } from './registry';
import type { ToolContext } from './types';

const BBOX = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_l5',
    callerActor: { kind: 'agent', ref: 'agent:ingestion_block_edit' },
  };
}

async function seedBlock(opts: {
  structured?: StructuredQuestionT | null;
  figures?: FigureRefT[];
}): Promise<string> {
  const db = testDb();
  const blockId = createId();
  const now = new Date();
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: createId(),
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
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return blockId;
}

beforeEach(async () => {
  await resetDb();
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

describe('get_question_block_structure', () => {
  it('registers as a read tool via registerCoreTools', () => {
    registerCoreTools();
    const tool = getTool('get_question_block_structure');
    expect(tool).toBeTruthy();
    expect(tool?.effect).toBe('read');
  });

  it('projects the draft structured tree clipped to addressing coords', async () => {
    const structured: StructuredQuestionT = {
      id: 'stem_1',
      role: 'stem',
      prompt_text: '阅读文段。',
      bbox: BBOX,
      page_index: 0,
      source: 'vlm_structure',
      extraction_evidence: { handwriting: [{ text: '甲', bbox: BBOX }] },
      sub_questions: [
        {
          id: 'sub_1',
          role: 'sub',
          question_no: '1',
          prompt_text: '解释加点字。',
          answers: ['代词'],
          bbox: BBOX,
          page_index: 1,
        },
      ],
    };
    const figures: FigureRefT[] = [
      {
        asset_id: 'asset_a',
        role: 'diagram',
        source_page_index: 0,
        source_bbox: BBOX,
        attached_to_index: 'sub_1',
        attach_confidence: 'high',
      },
    ];
    const blockId = await seedBlock({ structured, figures });

    const out = await getQuestionBlockStructureTool.execute(ctx(), { blockId });

    expect(out.structure?.tree.id).toBe('stem_1');
    expect(out.structure?.tree.sub_questions?.[0]).toEqual({
      id: 'sub_1',
      role: 'sub',
      question_no: '1',
      prompt_text: '解释加点字。',
      answers: ['代词'],
    });
    // Extraction-period coords clipped from the tree.
    expect(out.structure?.tree).not.toHaveProperty('bbox');
    expect(out.structure?.tree).not.toHaveProperty('page_index');
    expect(out.structure?.tree).not.toHaveProperty('extraction_evidence');
    // figures clipped to the addressing triple.
    expect(out.structure?.figures).toEqual([
      { asset_id: 'asset_a', role: 'diagram', attached_to_index: 'sub_1' },
    ]);
  });

  it('returns null structure when the block carries no structured tree', async () => {
    const blockId = await seedBlock({ structured: null });
    const out = await getQuestionBlockStructureTool.execute(ctx(), { blockId });
    expect(out.structure).toBeNull();
  });

  it('returns null structure when the block does not exist', async () => {
    const out = await getQuestionBlockStructureTool.execute(ctx(), {
      blockId: 'nope_does_not_exist',
    });
    expect(out.structure).toBeNull();
  });

  it('summarize reports the node count', async () => {
    const structured: StructuredQuestionT = {
      id: 'stem_1',
      role: 'stem',
      prompt_text: 'x',
      sub_questions: [
        { id: 'sub_1', role: 'sub', prompt_text: 'a' },
        { id: 'sub_2', role: 'sub', prompt_text: 'b' },
      ],
    };
    const blockId = await seedBlock({ structured });
    const out = await getQuestionBlockStructureTool.execute(ctx(), { blockId });
    // 1 stem + 2 subs = 3 addressable nodes.
    expect(getQuestionBlockStructureTool.summarize?.({ blockId }, out)).toContain('3 nodes');
  });
});
