// Phase 1c.2 Vision MVP — GET /api/ingestion/[id]/blocks
//
// Reads question_block rows for one session, returns them ordered by
// created_at asc so the UI shows them in extraction order.

import { event, learning_session, question_block } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './blocks';

async function seedSession(id: string): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_session).values({
    id,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: null,
    source_asset_ids: [],
    entrypoint: 'vision_single',
    warnings: [],
    error_message: null,
    summary_md: null,
    goal_id: null,
    started_at: now,
    ended_at: null,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedBlock(opts: {
  id: string;
  session_id: string;
  prompt?: string;
  layout?: 'structured' | 'partial' | 'text_only';
  created_at?: Date;
  source_asset_ids?: string[];
  image_refs?: string[];
  // biome-ignore lint/suspicious/noExplicitAny: tests pass arbitrary figure json through jsonb
  figures?: any[];
}): Promise<void> {
  const db = testDb();
  const now = opts.created_at ?? new Date();
  await db.insert(question_block).values({
    id: opts.id,
    ingestion_session_id: opts.session_id,
    source_document_id: null,
    source_asset_ids: opts.source_asset_ids ?? [],
    page_spans: [],
    extracted_prompt_md: opts.prompt ?? null,
    structured: null,
    figures: opts.figures ?? [],
    layout_quality: opts.layout ?? 'structured',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: opts.image_refs ?? [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 0.9,
    status: 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function getBlocks(sessionId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/ingestion/${sessionId}/blocks`, { method: 'GET' }), {
    id: sessionId,
  });
}

describe('GET /api/ingestion/[id]/blocks', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty rows when session has no blocks', async () => {
    await seedSession('sess1');
    const res = await getBlocks('sess1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('returns blocks for the given session ordered by created_at asc', async () => {
    await seedSession('sess1');
    const t0 = new Date('2026-05-16T12:00:00Z');
    await seedBlock({
      id: 'b2',
      session_id: 'sess1',
      prompt: 'second',
      created_at: new Date(t0.getTime() + 1000),
    });
    await seedBlock({
      id: 'b1',
      session_id: 'sess1',
      prompt: 'first',
      created_at: t0,
    });

    const res = await getBlocks('sess1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; extracted_prompt_md: string | null; created_at: number }>;
    };
    expect(body.rows.map((r) => r.id)).toEqual(['b1', 'b2']);
    expect(body.rows[0].extracted_prompt_md).toBe('first');
    expect(typeof body.rows[0].created_at).toBe('number');
  });

  it('does not leak blocks from other sessions', async () => {
    await seedSession('sess1');
    await seedSession('sess2');
    await seedBlock({ id: 'a', session_id: 'sess1' });
    await seedBlock({ id: 'b', session_id: 'sess2' });

    const res = await getBlocks('sess1');
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('surfaces layout_quality + image_refs + source_asset_ids + figures on the wire', async () => {
    await seedSession('sess1');
    await seedBlock({
      id: 'b1',
      session_id: 'sess1',
      layout: 'partial',
      source_asset_ids: ['asset_a', 'asset_b'],
      image_refs: ['asset_a'],
      figures: [
        {
          asset_id: 'fig_a',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
          attached_to_index: 'stem',
          attach_confidence: 'low',
        },
      ],
    });
    const res = await getBlocks('sess1');
    const body = (await res.json()) as {
      rows: Array<{
        layout_quality: string;
        image_refs: string[];
        source_asset_ids: string[];
        figures: Array<{ asset_id: string; attached_to_index: string }>;
      }>;
    };
    expect(body.rows[0].layout_quality).toBe('partial');
    expect(body.rows[0].image_refs).toEqual(['asset_a']);
    expect(body.rows[0].source_asset_ids).toEqual(['asset_a', 'asset_b']);
    expect(body.rows[0].figures[0]).toMatchObject({
      asset_id: 'fig_a',
      attached_to_index: 'stem',
    });
  });

  it('projects the latest auto-enroll observation for each block', async () => {
    await seedSession('sess1');
    await seedBlock({ id: 'b1', session_id: 'sess1' });
    await testDb()
      .insert(event)
      .values({
        id: 'evt_observe_b1',
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'workflow_judge',
        action: 'experimental:auto_enroll_observed',
        subject_kind: 'question_block',
        subject_id: 'b1',
        outcome: 'success',
        payload: {
          mode: 'observe',
          route: 'auto',
          confidence: 0.91,
          threshold: 0.85,
          reasoning: 'high agreement',
          suggested_knowledge_ids: ['k1', 'k2'],
        },
        caused_by_event_id: null,
        affected_scopes: [],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-16T12:01:00Z'),
        ingest_at: new Date('2026-05-16T12:01:00Z'),
      });

    const res = await getBlocks('sess1');
    const body = (await res.json()) as {
      rows: Array<{
        auto_enroll_observation: {
          event_id: string;
          route: string;
          confidence: number;
          threshold: number;
          reasoning: string;
          suggested_knowledge_ids: string[];
        } | null;
      }>;
    };
    expect(body.rows[0].auto_enroll_observation).toMatchObject({
      event_id: 'evt_observe_b1',
      route: 'auto',
      confidence: 0.91,
      threshold: 0.85,
      reasoning: 'high agreement',
      suggested_knowledge_ids: ['k1', 'k2'],
    });
  });

  it('surfaces mistake_draft under the pinned keys when the payload carries it', async () => {
    await seedSession('sess1');
    await seedBlock({ id: 'b1', session_id: 'sess1' });
    await testDb()
      .insert(event)
      .values({
        id: 'evt_observe_b1',
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'workflow_judge',
        action: 'experimental:auto_enroll_observed',
        subject_kind: 'question_block',
        subject_id: 'b1',
        outcome: 'failure',
        payload: {
          mode: 'observe',
          route: 'review',
          confidence: 0.8,
          threshold: 0.85,
          suggested_knowledge_ids: ['k1'],
          // raw MistakeEnrollOutput as written by auto-enroll.ts:303 — extra
          // fields (question_type/overall_confidence/reasoning) must be ignored.
          mistake_draft: {
            wrong_answer: 'failure',
            question_type: 'short_answer',
            difficulty: 4,
            cause: {
              primary_category: 'concept_gap',
              secondary_categories: [],
              analysis_md: 'student confused X with Y',
              confidence: 0.7,
            },
            overall_confidence: 0.8,
            reasoning: 'graded',
          },
        },
        caused_by_event_id: null,
        affected_scopes: [],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-16T12:01:00Z'),
        ingest_at: new Date('2026-05-16T12:01:00Z'),
      });

    const res = await getBlocks('sess1');
    const body = (await res.json()) as {
      rows: Array<{
        auto_enroll_observation: {
          mistake_draft: {
            wrong_answer: string | null;
            difficulty: number | null;
            cause: { primary_category: string | null; analysis_md: string | null } | null;
          } | null;
        } | null;
      }>;
    };
    // EXACT pinned key set: wrong_answer (NOT outcome), difficulty, cause:{primary_category,analysis_md}.
    expect(body.rows[0].auto_enroll_observation?.mistake_draft).toEqual({
      wrong_answer: 'failure',
      difficulty: 4,
      cause: {
        primary_category: 'concept_gap',
        analysis_md: 'student confused X with Y',
      },
    });
  });

  it('mistake_draft is null when the observe payload omits it', async () => {
    await seedSession('sess1');
    await seedBlock({ id: 'b1', session_id: 'sess1' });
    await testDb()
      .insert(event)
      .values({
        id: 'evt_observe_b1',
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'workflow_judge',
        action: 'experimental:auto_enroll_observed',
        subject_kind: 'question_block',
        subject_id: 'b1',
        outcome: 'success',
        payload: {
          mode: 'observe',
          route: 'auto',
          confidence: 0.95,
          threshold: 0.85,
          suggested_knowledge_ids: [],
        },
        caused_by_event_id: null,
        affected_scopes: [],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-16T12:01:00Z'),
        ingest_at: new Date('2026-05-16T12:01:00Z'),
      });

    const res = await getBlocks('sess1');
    const body = (await res.json()) as {
      rows: Array<{ auto_enroll_observation: { mistake_draft: unknown } | null }>;
    };
    expect(body.rows[0].auto_enroll_observation?.mistake_draft).toBeNull();
  });

  it('tolerant projection keeps present mistake_draft fields and nulls the absent ones', async () => {
    await seedSession('sess1');
    await seedBlock({ id: 'b1', session_id: 'sess1' });
    await testDb()
      .insert(event)
      .values({
        id: 'evt_observe_b1',
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'workflow_judge',
        action: 'experimental:auto_enroll_observed',
        subject_kind: 'question_block',
        subject_id: 'b1',
        outcome: 'partial',
        payload: {
          mode: 'observe',
          route: 'review',
          confidence: 0.7,
          threshold: 0.85,
          suggested_knowledge_ids: [],
          // legacy/partial draft: missing difficulty + no cause object.
          mistake_draft: {
            wrong_answer: 'partial',
          },
        },
        caused_by_event_id: null,
        affected_scopes: [],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date('2026-05-16T12:01:00Z'),
        ingest_at: new Date('2026-05-16T12:01:00Z'),
      });

    const res = await getBlocks('sess1');
    const body = (await res.json()) as {
      rows: Array<{
        auto_enroll_observation: {
          mistake_draft: {
            wrong_answer: string | null;
            difficulty: number | null;
            cause: unknown;
          } | null;
        } | null;
      }>;
    };
    // The whole draft is NOT dropped — present field survives, absent ones null.
    expect(body.rows[0].auto_enroll_observation?.mistake_draft).toEqual({
      wrong_answer: 'partial',
      difficulty: null,
      cause: null,
    });
  });
});
