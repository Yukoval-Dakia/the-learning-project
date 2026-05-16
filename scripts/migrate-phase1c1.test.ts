// Phase 1c.1 Step 3 migration — unit tests per migrate fn.
//
// Each test pre-seeds a legacy fixture (mistake / review_event / dreaming_proposal /
// ingestion_session) and asserts the migrate function produces the expected
// event / learning_session / material_fsrs_state rows. Every constructed event
// must pass `parseEvent` (verified inside the migrate fn) — this guards against
// silent drift from Lane B's locked KnownEvent contract.

import { question, mistake, event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../tests/helpers/db';
import { migrateMistakes } from './migrate-phase1c1';

const QUESTION_ID = 'q_test_001';

async function seedQuestion(id: string = QUESTION_ID) {
  const db = testDb();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'test prompt',
    source: 'manual',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('migrateMistakes — no-cause path (3.A)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedQuestion();
  });

  it('emits 1 attempt event for a mistake with no cause', async () => {
    const db = testDb();
    const mistakeId = 'm_no_cause_001';
    const now = new Date('2026-02-01T12:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      wrong_answer_md: 'my wrong answer',
      wrong_answer_image_refs: ['img1', 'img2'],
      source: 'manual',
      knowledge_ids: ['k1', 'k2'],
      cause: null,
      fsrs_state: null,
      created_at: now,
      updated_at: now,
    });

    await migrateMistakes(db);

    const events = await db.select().from(event);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.id).toBe(`evt_mistake_${mistakeId}`);
    expect(ev.action).toBe('attempt');
    expect(ev.subject_kind).toBe('question');
    expect(ev.subject_id).toBe(QUESTION_ID);
    expect(ev.outcome).toBe('failure');
    expect(ev.actor_kind).toBe('user');
    expect(ev.actor_ref).toBe('self');
    expect(ev.session_id).toBeNull();
    expect(ev.caused_by_event_id).toBeNull();
    expect(ev.payload).toEqual({
      answer_md: 'my wrong answer',
      answer_image_refs: ['img1', 'img2'],
      referenced_knowledge_ids: ['k1', 'k2'],
    });
  });

  it('coalesces null wrong_answer_md / knowledge_ids defaults', async () => {
    const db = testDb();
    const mistakeId = 'm_null_fields_001';
    const now = new Date('2026-02-02T12:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      wrong_answer_md: null,
      source: 'quiz_answer',
      cause: null,
      fsrs_state: null,
      created_at: now,
      updated_at: now,
    });

    await migrateMistakes(db);

    const events = await db.select().from(event).where(eq(event.id, `evt_mistake_${mistakeId}`));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      answer_md: null,
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    });
  });
});

describe('migrateMistakes — cause bridge (3.B)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedQuestion();
  });

  it('emits attempt + chained judge for mistake with full legacy cause', async () => {
    const db = testDb();
    const mistakeId = 'm_with_cause_001';
    const created = new Date('2026-02-01T10:00:00Z');
    const updated = new Date('2026-02-01T11:00:00Z'); // judge timestamp
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      wrong_answer_md: 'wrong',
      wrong_answer_image_refs: [],
      source: 'manual',
      knowledge_ids: ['k_concept_a'],
      // Full legacy Cause shape from business.ts
      cause: {
        primary_category: 'concept',
        secondary_categories: ['knowledge_gap'],
        ai_analysis_md: '错因分析正文',
        user_notes: 'user wrote this',
        partial: false,
        confidence: 0.85,
        user_edited: true,
      },
      fsrs_state: null,
      created_at: created,
      updated_at: updated,
    });

    await migrateMistakes(db);

    const events = await db.select().from(event);
    expect(events).toHaveLength(2);

    const attempt = events.find((e) => e.action === 'attempt');
    const judge = events.find((e) => e.action === 'judge');
    expect(attempt).toBeDefined();
    expect(judge).toBeDefined();
    if (!attempt || !judge) return;

    // judge chains on attempt
    expect(judge.caused_by_event_id).toBe(attempt.id);
    expect(judge.subject_kind).toBe('event');
    expect(judge.subject_id).toBe(attempt.id);
    expect(judge.actor_kind).toBe('agent');
    expect(judge.actor_ref).toBe('legacy_attribution');
    expect(judge.outcome).toBe('success');
    expect(judge.created_at).toEqual(updated); // best-proxy: mistake.updated_at

    // Cause bridge: ai_analysis_md → analysis_md; user_notes/partial/user_edited dropped
    expect(judge.payload).toEqual({
      cause: {
        primary_category: 'concept',
        secondary_categories: ['knowledge_gap'],
        analysis_md: '错因分析正文',
        confidence: 0.85,
      },
      referenced_knowledge_ids: ['k_concept_a'],
    });
  });

  it('defaults confidence=0.5 when legacy confidence is null', async () => {
    const db = testDb();
    const mistakeId = 'm_null_conf_001';
    const now = new Date('2026-02-03T00:00:00Z');
    await db.insert(mistake).values({
      id: mistakeId,
      question_id: QUESTION_ID,
      source: 'manual',
      // Legacy jsonb shape — cast through unknown since some legacy rows
      // omit secondary_categories / confidence (Zod default fills them at parse).
      cause: {
        primary_category: 'carelessness',
        ai_analysis_md: 'forgot to check',
        user_edited: false,
        // secondary_categories + confidence missing — exercise bridge defaults
      } as unknown as NonNullable<typeof mistake.$inferInsert.cause>,
      fsrs_state: null,
      created_at: now,
      updated_at: now,
    });

    await migrateMistakes(db);

    const judge = (await db.select().from(event)).find((e) => e.action === 'judge');
    expect(judge).toBeDefined();
    const payload = judge?.payload as { cause: { confidence: number; secondary_categories: string[] } };
    expect(payload.cause.confidence).toBe(0.5);
    expect(payload.cause.secondary_categories).toEqual([]);
  });
});
