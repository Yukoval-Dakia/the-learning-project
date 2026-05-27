// YUK-101 (iter2 fix F12) — shared test fixture for event seeding.
//
// Code-review against PR #163 flagged three coupled problems in the seed
// helpers introduced by the YUK-100 W-05 fix:
//
//   1. `seedFailureAttempt` + `seedUserCause` were duplicated byte-for-byte
//      across `advice/route.test.ts` + `submit/route.test.ts`.
//   2. Both copies direct-insert into `event`, bypassing the ADR-0005
//      single-owner INSERT path (`writeEvent`) — every other test in the
//      repo bypasses too, so this isn't unique, but the duplication makes
//      the bypass surface twice.
//   3. Both copies omit the paired `learning_record(kind='mistake')` row
//      that `app/api/mistakes/route.test.ts:415-438` and other test files
//      create alongside every failure attempt. A future route change that
//      joins `event` → `learning_record` would silently 404 the join in
//      tests that use the iter1 helpers (advice + submit) while passing in
//      tests that use the canonical helpers — diverging coverage.
//
// This module owns the canonical seed shape. New tests should import from
// here; existing duplicates in advice/submit get replaced.
//
// The seed routines deliberately match the established repo pattern of
// direct `db.insert` — `parseEvent` validation in `writeEvent` is the
// production path, but test fixtures need to be free to set up edge cases
// (rolled-back-then-active, partial cause attachment, etc.) that would
// otherwise require a complex multi-step writeEvent dance. ADR-0005's
// "raw db.insert(event) outside this module is forbidden" applies to
// production code; the helpers below carry the audit reference instead.

import { newId } from '@/core/ids';
import { event, learning_record } from '@/db/schema';
import { testDb } from './db';

export interface SeedAttemptOptions {
  id: string;
  question_id: string;
  outcome?: 'failure' | 'success' | 'partial';
  answer_md?: string;
  knowledge_ids?: string[];
  created_at?: Date;
  /**
   * When true (default for outcome='failure'), seed a paired
   * `learning_record(kind='mistake', attempt_event_id=id)` so tests that
   * later join through learning_record see the row. Set false for cases
   * that explicitly want an attempt with no mistake mirror.
   */
  with_learning_record?: boolean;
}

/**
 * Seed an `attempt` event on a question. When the attempt is a failure
 * (default), a paired `learning_record(kind='mistake')` row is also
 * inserted unless `with_learning_record:false` is passed.
 *
 * Mirrors `app/api/mistakes/route.test.ts:seedAttempt` (the established
 * canonical shape).
 */
export async function seedAttempt(opts: SeedAttemptOptions): Promise<void> {
  const db = testDb();
  const createdAt = opts.created_at ?? new Date();
  const outcome = opts.outcome ?? 'failure';
  const answerMd = opts.answer_md ?? 'wrong';
  const knowledgeIds = opts.knowledge_ids ?? ['k1'];

  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.question_id,
    outcome,
    payload: {
      answer_md: answerMd,
      answer_image_refs: [],
      referenced_knowledge_ids: knowledgeIds,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: createdAt,
  });

  const shouldMirror = opts.with_learning_record ?? outcome === 'failure';
  if (shouldMirror) {
    await db.insert(learning_record).values({
      id: `lr_${opts.id}`,
      kind: 'mistake',
      title: null,
      content_md: answerMd,
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'attempt',
      processing_status: 'raw',
      origin_event_id: opts.id,
      subject_id: null,
      knowledge_ids: knowledgeIds,
      question_id: opts.question_id,
      attempt_event_id: opts.id,
      learning_item_id: null,
      artifact_id: null,
      source_document_id: null,
      asset_refs: [],
      payload: { wrong_answer_md: answerMd },
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: null,
      version: 0,
    });
  }
}

export interface SeedUserCauseOptions {
  /** Defaults to `newId()` when omitted — most tests don't need to address
   * the cause row by id. */
  id?: string;
  attempt_event_id: string;
  primary_category: string;
  user_notes?: string | null;
  created_at?: Date;
}

/**
 * Seed an `experimental:user_cause` event chained to `attempt_event_id`.
 * Cause SoT (CC-1): `effectiveCauseCategoryForFailureAttempt()` reads
 * these rows.
 */
export async function seedUserCause(opts: SeedUserCauseOptions): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id ?? newId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: opts.attempt_event_id,
    outcome: null,
    payload: {
      primary_category: opts.primary_category,
      user_notes: opts.user_notes ?? null,
    },
    caused_by_event_id: opts.attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}
