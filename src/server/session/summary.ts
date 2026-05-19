// Phase 1d — SessionSummaryTask runner.
//
// Called by the session_summary pg-boss handler (or directly in tests) after a
// learning_session(type='review') transitions to completed. Builds a compact
// stats snapshot from chained events, calls SessionSummaryTask via the AI
// runner, writes the result into learning_session.summary_md.
//
// Errors are swallowed by the caller (handler does best-effort retry; missing
// summary degrades gracefully — the /learning-sessions/[id] UI shows a stub).

import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event, knowledge, learning_session, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';

const NOTABLE_LIMIT = 3;

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export interface RunSessionSummaryParams {
  db: Db;
  sessionId: string;
  runTaskFn: RunTaskFn;
}

export interface RunSessionSummaryResult {
  /** 'written' = summary saved; 'skipped:<reason>' = no-op (already had a summary, no events, etc.). */
  status: 'written' | 'skipped:no_session' | 'skipped:no_events' | 'skipped:already_summarized';
  summary_md?: string;
}

/**
 * Generate + persist a short markdown summary for a finished review session.
 *
 * Idempotent: skips if summary_md is already set (re-running won't overwrite).
 * Bounded read: only review events on this session_id are considered.
 */
export async function runSessionSummary(
  params: RunSessionSummaryParams,
): Promise<RunSessionSummaryResult> {
  const { db, sessionId, runTaskFn } = params;

  const sessRows = await db
    .select({
      id: learning_session.id,
      type: learning_session.type,
      status: learning_session.status,
      summary_md: learning_session.summary_md,
      started_at: learning_session.started_at,
      ended_at: learning_session.ended_at,
    })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const sess = sessRows[0];
  if (!sess) return { status: 'skipped:no_session' };
  if (sess.summary_md) return { status: 'skipped:already_summarized' };

  const reviewEvents = await db
    .select({
      id: event.id,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, 'review'),
        eq(event.subject_kind, 'question'),
      ),
    )
    .orderBy(asc(event.created_at));

  if (reviewEvents.length === 0) {
    return { status: 'skipped:no_events' };
  }

  // Stats from review payloads.
  const ratings = { again: 0, hard: 0, good: 0, easy: 0 };
  const knowledgeCounts = new Map<string, number>();
  for (const r of reviewEvents) {
    const payload = r.payload as {
      fsrs_rating?: 'again' | 'hard' | 'good' | 'easy';
      referenced_knowledge_ids?: string[];
    };
    if (payload.fsrs_rating && payload.fsrs_rating in ratings) {
      ratings[payload.fsrs_rating] += 1;
    }
    for (const k of payload.referenced_knowledge_ids ?? []) {
      knowledgeCounts.set(k, (knowledgeCounts.get(k) ?? 0) + 1);
    }
  }
  const topKnowledge = [...knowledgeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ id, count }));
  const firstKnowledgeId = knowledgeCounts.keys().next().value as string | undefined;
  const firstDomain = firstKnowledgeId
    ? (
        await db
          .select({ domain: knowledge.domain })
          .from(knowledge)
          .where(eq(knowledge.id, firstKnowledgeId))
          .limit(1)
      )[0]?.domain
    : null;

  // Cause distribution from chained judge events (judges on the original
  // failure attempts — not session-bound, but joined by question).
  const questionIds = Array.from(new Set(reviewEvents.map((r) => r.subject_id)));
  const causeCounts = new Map<string, number>();
  if (questionIds.length > 0) {
    const attemptIds = (
      await db
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'attempt'),
            eq(event.subject_kind, 'question'),
            eq(event.outcome, 'failure'),
            inArray(event.subject_id, questionIds),
          ),
        )
    ).map((r) => r.id);
    if (attemptIds.length > 0) {
      const judges = await db
        .select({ payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            inArray(event.caused_by_event_id, attemptIds),
          ),
        );
      for (const j of judges) {
        const cat = (j.payload as { cause?: { primary_category?: string } }).cause
          ?.primary_category;
        if (cat) causeCounts.set(cat, (causeCounts.get(cat) ?? 0) + 1);
      }
    }
  }
  const topCauses = [...causeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([category, count]) => ({ category, count }));

  // Notable attempts (the again/hard ones, up to NOTABLE_LIMIT) — join question.
  const notable = reviewEvents
    .filter((r) => {
      const rating = (r.payload as { fsrs_rating?: string }).fsrs_rating;
      return rating === 'again' || rating === 'hard';
    })
    .slice(0, NOTABLE_LIMIT);
  const notableQuestionIds = notable.map((r) => r.subject_id);
  const qById = new Map<string, { prompt_md: string }>();
  if (notableQuestionIds.length > 0) {
    const qrows = await db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      .where(inArray(question.id, notableQuestionIds));
    for (const q of qrows) qById.set(q.id, { prompt_md: q.prompt_md });
  }
  const notableAttempts = notable.map((r) => {
    const p = r.payload as { fsrs_rating?: string; user_response_md?: string | null };
    return {
      prompt_md: qById.get(r.subject_id)?.prompt_md ?? '(题面缺失)',
      user_response_md: p.user_response_md ?? null,
      fsrs_rating: p.fsrs_rating ?? null,
    };
  });

  const durationMin =
    sess.ended_at && sess.started_at
      ? Math.round((sess.ended_at.getTime() - sess.started_at.getTime()) / 60_000)
      : null;

  const input = {
    session_id: sessionId,
    duration_min: durationMin,
    total_reviewed: reviewEvents.length,
    ratings,
    top_causes: topCauses,
    top_knowledge: topKnowledge,
    notable_attempts: notableAttempts,
  };

  const result = await runTaskFn('SessionSummaryTask', input, {
    db,
    subjectProfile: resolveSubjectProfile(firstDomain),
  });
  // Trim + soft-cap to 240 chars (allows ~120 Chinese chars; prompt asks for
  // ≤120 but we don't reject — clamp instead so the model occasionally going
  // slightly over doesn't lose the whole summary).
  const summaryMd = result.text.trim().slice(0, 240);
  if (summaryMd.length === 0) {
    return { status: 'skipped:no_events' };
  }

  await db
    .update(learning_session)
    .set({ summary_md: summaryMd, updated_at: new Date() })
    .where(eq(learning_session.id, sessionId));

  return { status: 'written', summary_md: summaryMd };
}
