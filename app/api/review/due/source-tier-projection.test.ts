// YUK-226 S2-5a.0 (B1) — due-list candidate-SELECT projection widening regression.
//
// 5a widens the two candidate SELECTs in due-list.ts (the raw-SQL
// `pickQuestionForKnowledge` + the drizzle `legacyQuestionStateRows` builder) to
// project `source` + `metadata` so downstream read models can derive a source
// tier. This is a PROJECTION-ONLY change: the WHERE / ORDER / Gate-B draft filter
// are untouched, so the scheduling hot path (ADR-0028 FSRS due ordering, Gate-B
// draft exclusion, round-robin) must behave EXACTLY as before. This file guards:
//   1. the widened projection does not change which rows surface, their order, or
//      the Gate-B draft exclusion (the existing slice contract);
//   2. a question with varied source/metadata (ingestion provenance, web_sourced,
//      quiz_gen) still surfaces unchanged — the new columns ride along without
//      affecting selection (tier influences selection only in the read-model
//      consumers, never in due-list itself — spec §7-3: tier affects WHICH题, not
//      WHEN to review).
//
// DB test (testDb): imports @/db + tests/helpers/db → runs in the db config.

import { material_fsrs_state, question } from '@/db/schema';
import { handleReviewDue } from '@/server/review/due-list';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-06-06T12:00:00.000Z');

function makeFsrsState(due: Date) {
  return {
    due: due.toISOString(),
    stability: 1.5,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    last_review: null,
  };
}

async function seedQuestion(opts: {
  id: string;
  knowledge_ids: string[];
  createdAt: Date;
  source?: string;
  metadata?: Record<string, unknown>;
  draft?: boolean;
}) {
  await testDb()
    .insert(question)
    .values({
      id: opts.id,
      kind: 'short_answer',
      prompt_md: `P ${opts.id}`,
      reference_md: null,
      knowledge_ids: opts.knowledge_ids,
      difficulty: 3,
      source: opts.source ?? 'manual',
      metadata: (opts.metadata ?? {}) as never,
      draft_status: opts.draft ? 'draft' : null,
      variant_depth: 0,
      version: 0,
      created_at: opts.createdAt,
      updated_at: opts.createdAt,
    });
}

// Overdue card keyed on the question itself (subject_kind='question') — exercises
// the legacyQuestionStateRows builder branch widened by 5a.0(ii).
async function seedOverdueQuestion(opts: {
  id: string;
  knowledge_ids: string[];
  dueAt: Date;
  createdAt: Date;
  source?: string;
  metadata?: Record<string, unknown>;
  draft?: boolean;
}) {
  await seedQuestion(opts);
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: `f_${opts.id}`,
      subject_kind: 'question',
      subject_id: opts.id,
      state: makeFsrsState(opts.dueAt) as never,
      due_at: opts.dueAt,
      last_review_event_id: null,
      updated_at: NOW,
    });
}

// Overdue card keyed on a knowledge node (subject_kind='knowledge') — exercises
// the raw-SQL pickQuestionForKnowledge branch widened by 5a.0(i).
async function seedOverdueKnowledge(opts: {
  questionId: string;
  knowledgeId: string;
  dueAt: Date;
  createdAt: Date;
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  await seedQuestion({
    id: opts.questionId,
    knowledge_ids: [opts.knowledgeId],
    createdAt: opts.createdAt,
    source: opts.source,
    metadata: opts.metadata,
  });
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: `f_k_${opts.knowledgeId}`,
      subject_kind: 'knowledge',
      subject_id: opts.knowledgeId,
      state: makeFsrsState(opts.dueAt) as never,
      due_at: opts.dueAt,
      last_review_event_id: null,
      updated_at: NOW,
    });
}

type DueRow = {
  id: string;
  question_id: string;
  fsrs_state: unknown;
  prompt_md?: string;
  knowledge_ids: string[];
};

async function getDue(): Promise<DueRow[]> {
  const res = await handleReviewDue(new Request('http://localhost/api/review/due?limit=50'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: DueRow[] };
  return body.rows;
}

const T0 = new Date('2026-06-01T00:00:00.000Z');

describe('due-list source/metadata projection widening (5a.0)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('preserves due-ordering after widening the legacy-question projection', async () => {
    // Three overdue cards with distinct due_at + distinct source/metadata shapes.
    await seedOverdueQuestion({
      id: 'q_a',
      knowledge_ids: ['k1'],
      dueAt: new Date('2026-06-03T00:00:00.000Z'),
      createdAt: T0,
      source: 'vision_paper',
      metadata: { ingestion_session_id: 'sess_1' },
    });
    await seedOverdueQuestion({
      id: 'q_b',
      knowledge_ids: ['k1'],
      dueAt: new Date('2026-06-04T00:00:00.000Z'),
      createdAt: T0,
      source: 'web_sourced',
      metadata: {
        source_ref_kind: 'url',
        web_sourced: {
          url: 'https://example.com/q',
          title: 't',
          fetched_at: '2026-06-06T00:00:00Z',
          whitelist_match: true,
        },
      },
    });
    await seedOverdueQuestion({
      id: 'q_c',
      knowledge_ids: ['k1'],
      dueAt: new Date('2026-06-05T00:00:00.000Z'),
      createdAt: T0,
      source: 'quiz_gen',
      metadata: {},
    });

    const rows = await getDue();
    const ids = rows.map((r) => r.id);
    // due_at asc ordering preserved (single subject → no round-robin reshuffle).
    expect(ids).toEqual(['q_a', 'q_b', 'q_c']);
  });

  it('still excludes draft questions after widening (Gate-B unchanged)', async () => {
    await seedOverdueQuestion({
      id: 'q_active',
      knowledge_ids: ['k1'],
      dueAt: new Date('2026-06-03T00:00:00.000Z'),
      createdAt: T0,
      source: 'web_sourced',
      metadata: {
        source_ref_kind: 'url',
        web_sourced: {
          url: 'https://example.com/q',
          title: 't',
          fetched_at: '2026-06-06T00:00:00Z',
          whitelist_match: false,
        },
      },
    });
    await seedOverdueQuestion({
      id: 'q_draft',
      knowledge_ids: ['k1'],
      dueAt: new Date('2026-06-04T00:00:00.000Z'),
      createdAt: T0,
      source: 'web_sourced',
      metadata: {},
      draft: true,
    });

    const ids = (await getDue()).map((r) => r.id);
    expect(ids).toContain('q_active');
    expect(ids).not.toContain('q_draft');
  });

  it('surfaces a knowledge-keyed candidate unchanged after widening the raw-SQL projection', async () => {
    await seedOverdueKnowledge({
      questionId: 'q_k',
      knowledgeId: 'k_zhi',
      dueAt: new Date('2026-06-03T00:00:00.000Z'),
      createdAt: T0,
      source: 'vision_paper',
      metadata: { ingestion_session_id: 'sess_1' },
    });

    const ids = (await getDue()).map((r) => r.id);
    expect(ids).toContain('q_k');
  });
});
