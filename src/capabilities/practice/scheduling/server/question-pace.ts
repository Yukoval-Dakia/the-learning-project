// observed question pace for the daily review plan.
// The plan and the practice stream must not disagree about how long a question
// takes. This reader is the only place that derives the measured value; both
// surfaces pass it into `@/core/daily-review-plan`.
// Scoped samples use frozen submission subject and question-kind facts. Unknown
// scope stays default; the omitted-scope overload retains the historical global read.
// Samples are the learner's own `duration_ms` on the last 200 question
// attempts/reviews within 14 days. Wall-clock timing includes idle time, so
// samples above 10 minutes are dropped (a backgrounded tab is not a slower
// question), sub-second samples are ignored, the remaining samples are
// summarized by their median, and fewer than 5 usable samples falls back to
// the default (2 minutes).

import { and, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  DEFAULT_QUESTION_MINUTES,
  MAX_QUESTION_MINUTES,
  normalizeQuestionMinutes,
} from '@/core/daily-review-plan';
import type { Db, Tx } from '@/db/client';
import { event, question_group_lifecycle } from '@/db/schema';
import { LearningScope } from '@/kernel/read-models/assessment-learning-scope';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';
import { medianOf } from '@/kernel/read-models/question-activity';
import { getDefaultSubjectRegistry, resolveKnownSubjectId } from '@/subjects/profile';

type DbLike = Db | Tx;

export const QUESTION_PACE_WINDOW_DAYS = 14;
export const QUESTION_PACE_SAMPLE_LIMIT = 200;
export const QUESTION_PACE_MIN_SAMPLES = 5;
const MIN_SAMPLE_MS = 1_000;
const MAX_SAMPLE_MS = MAX_QUESTION_MINUTES * 60_000;

export interface QuestionPaceScope {
  subjectId: string;
  questionKind: string;
}

export interface QuestionPace {
  minutes: number;
  source: 'observed' | 'default';
  sample_count: number;
}

export async function readQuestionPace(
  db: DbLike,
  now: Date = new Date(),
  scope?: QuestionPaceScope | null,
): Promise<QuestionPace> {
  // Explicitly unknown scope must not silently borrow an unrelated global pace.
  if (scope === null || (scope !== undefined && (!scope.subjectId || !scope.questionKind))) {
    return { minutes: DEFAULT_QUESTION_MINUTES, source: 'default', sample_count: 0 };
  }
  if (scope !== undefined) {
    const subjectId = resolveKnownSubjectId(scope.subjectId);
    if (!subjectId) return defaultPace();
    const knownScope = { ...scope, subjectId };
    return readScopedPace(db, knownScope, now);
  }
  const since = new Date(now.getTime() - QUESTION_PACE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
        eq(event.subject_kind, 'question'),
        gte(event.created_at, since),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(QUESTION_PACE_SAMPLE_LIMIT);

  return summarizePace(rows.map((row) => (row.payload as { duration_ms?: unknown }).duration_ms));
}

function defaultPace(): QuestionPace {
  return { minutes: DEFAULT_QUESTION_MINUTES, source: 'default', sample_count: 0 };
}

function summarizePace(durations: unknown[]): QuestionPace {
  const samples = durations
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .filter((value) => value >= MIN_SAMPLE_MS && value <= MAX_SAMPLE_MS);
  if (samples.length < QUESTION_PACE_MIN_SAMPLES) {
    return { ...defaultPace(), sample_count: samples.length };
  }
  return {
    minutes: normalizeQuestionMinutes(
      (medianOf(samples) ?? DEFAULT_QUESTION_MINUTES * 60_000) / 60_000,
    ),
    source: 'observed',
    sample_count: samples.length,
  };
}

function scopeKey(scope: QuestionPaceScope): string {
  return JSON.stringify([scope.subjectId, scope.questionKind]);
}

const submissionReceipt = alias(event, 'pace_submission_receipt');

function frozenScope(payload: unknown, questionId: string): QuestionPaceScope | null {
  const parsed = LearningScope.safeParse(payload);
  if (!parsed.success) return null;
  const item = parsed.data.questions.find((row) => row.id === questionId);
  if (!item || item.knowledge_ids.length === 0 || !item.kind) return null;
  const subjects = item.knowledge_ids.map((id) =>
    resolveKnownSubjectId(parsed.data.ability_global_by_knowledge_id[id]),
  );
  const subjectId = subjects[0];
  if (!subjectId || subjects.some((id) => id !== subjectId)) return null;
  return { subjectId, questionKind: item.kind };
}

async function readScopedPace(
  db: DbLike,
  scope: QuestionPaceScope,
  now: Date,
): Promise<QuestionPace> {
  const durations: unknown[] = [];
  const since = new Date(now.getTime() - QUESTION_PACE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const domains = [scope.subjectId, ...getDefaultSubjectRegistry().listAliasesFor(scope.subjectId)];
  let cursor: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const rows = await db
      .select({
        id: event.id,
        createdAt: event.created_at,
        questionId: event.subject_id,
        payload: event.payload,
        learningScope: sql<unknown>`${submissionReceipt.payload}->'learning_scope'`,
      })
      .from(event)
      .leftJoin(
        submissionReceipt,
        and(
          eq(submissionReceipt.action, 'experimental:assessment_submission'),
          eq(submissionReceipt.subject_kind, 'submission'),
          eq(submissionReceipt.subject_id, sql<string>`${event.payload}->>'submission_id'`),
        ),
      )
      .where(
        and(
          eq(event.actor_kind, 'user'),
          eq(event.action, 'experimental:assessment_attempt'),
          eq(event.subject_kind, 'question'),
          gte(event.created_at, since),
          lte(event.created_at, now),
          // Filter before the page cap; another subject cannot evict this scope's samples.
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(${submissionReceipt.payload} #> '{learning_scope,questions}') = 'array'
                THEN ${submissionReceipt.payload} #> '{learning_scope,questions}' ELSE '[]'::jsonb END
            ) AS frozen_question
            WHERE frozen_question->>'id' = ${event.subject_id}
              AND frozen_question->>'kind' = ${scope.questionKind}
              AND lower(btrim(normalize((${submissionReceipt.payload} #> '{learning_scope,ability_global_by_knowledge_id}') ->> (frozen_question #>> '{knowledge_ids,0}'), NFC)))
                IN (${sql.join(
                  domains.map((domain) => sql`${domain}`),
                  sql`, `,
                )})
          )`,
          cursor === undefined
            ? undefined
            : or(
                lt(event.created_at, cursor.createdAt),
                and(eq(event.created_at, cursor.createdAt), lt(event.id, cursor.id)),
              ),
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(QUESTION_PACE_SAMPLE_LIMIT);
    for (const row of rows) {
      const frozen = frozenScope(row.learningScope, row.questionId);
      if (frozen?.subjectId === scope.subjectId && frozen.questionKind === scope.questionKind) {
        durations.push(row.payload.duration_ms);
        if (durations.length === QUESTION_PACE_SAMPLE_LIMIT) break;
      }
    }
    const last = rows.at(-1);
    if (
      !last ||
      rows.length < QUESTION_PACE_SAMPLE_LIMIT ||
      durations.length === QUESTION_PACE_SAMPLE_LIMIT
    )
      break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return summarizePace(durations);
}

/** Unknown historical subject/shape is not reconstructed from today's mutable question tags. */
export async function readQuestionPacesForQuestions(
  db: DbLike,
  questionIds: readonly string[],
  now: Date = new Date(),
): Promise<{
  byQuestion: Map<string, QuestionPace>;
  overall: QuestionPace;
  unscoped: QuestionPace;
}> {
  const ids = [...new Set(questionIds)];
  const unscoped = await readQuestionPace(db, now);
  if (ids.length === 0) return { byQuestion: new Map(), overall: defaultPace(), unscoped };
  const anchors = await db
    .selectDistinctOn([event.subject_id], {
      questionId: event.subject_id,
      revisionId: sql<string>`${event.payload}->>'revision_id'`,
      currentRevisionId: question_group_lifecycle.current_revision_id,
      learningScope: sql<unknown>`${submissionReceipt.payload}->'learning_scope'`,
    })
    .from(event)
    .leftJoin(
      submissionReceipt,
      and(
        eq(submissionReceipt.action, 'experimental:assessment_submission'),
        eq(submissionReceipt.subject_kind, 'submission'),
        eq(submissionReceipt.subject_id, sql<string>`${event.payload}->>'submission_id'`),
      ),
    )
    .leftJoin(
      question_group_lifecycle,
      eq(
        question_group_lifecycle.group_id,
        sql<string>`${submissionReceipt.payload} #>> '{learning_scope,group_id}'`,
      ),
    )
    .where(
      and(
        eq(event.actor_kind, 'user'),
        eq(event.action, 'experimental:assessment_attempt'),
        eq(event.subject_kind, 'question'),
        inArray(event.subject_id, ids),
        lte(event.created_at, now),
      ),
    )
    .orderBy(event.subject_id, desc(event.created_at), desc(event.id));
  const scopes = new Map(
    anchors.map((row) => [
      row.questionId,
      // A republished shape has no current frozen attempt yet; its old shape is not a forecast.
      row.revisionId && row.revisionId === row.currentRevisionId
        ? frozenScope(row.learningScope, row.questionId)
        : null,
    ]),
  );
  const uniqueScopes = new Map(
    [...scopes.values()]
      .filter((scope): scope is QuestionPaceScope => scope !== null)
      .map((scope) => [scopeKey(scope), scope]),
  );
  const paces = new Map(
    await Promise.all(
      [...uniqueScopes].map(
        async ([key, scope]) => [key, await readQuestionPace(db, now, scope)] as const,
      ),
    ),
  );
  const byQuestion = new Map(
    ids.map((id) => {
      const scope = scopes.get(id);
      return [id, scope ? (paces.get(scopeKey(scope)) ?? defaultPace()) : defaultPace()];
    }),
  );
  const values = [...byQuestion.values()];
  return {
    byQuestion,
    unscoped,
    overall: {
      minutes: values.reduce((sum, pace) => sum + pace.minutes, 0) / values.length,
      source: values.every((pace) => pace.source === 'observed') ? 'observed' : 'default',
      sample_count: [...paces.values()].reduce((sum, pace) => sum + pace.sample_count, 0),
    },
  };
}

/** Attach scoped question prices while retaining the caller's paper slot counts. */
export async function readQuestionPacesForStreamItems<
  Item extends { item_kind: 'question' | 'paper'; ref_id: string },
>(db: DbLike, items: readonly Item[], now: Date = new Date()) {
  const paces = await readQuestionPacesForQuestions(
    db,
    items.filter((item) => item.item_kind === 'question').map((item) => item.ref_id),
    now,
  );
  return {
    ...paces,
    items: items.map((item) => ({
      ...item,
      estimatedMinutes:
        item.item_kind === 'question' ? paces.byQuestion.get(item.ref_id)?.minutes : undefined,
    })),
  };
}
