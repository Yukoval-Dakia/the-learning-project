import { z } from 'zod';
import { SchedulingStateSchema, isCandidateState } from '@/core/schema/scheduling-state';
import { projectNativeCsv } from './native-assessment-reporting';

export interface Row {
  [k: string]: unknown;
}

export function csvEscape(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const MISTAKES_HEADERS = [
  'id',
  'created_at',
  'prompt_md',
  'reference_md',
  'wrong_answer_md',
  'knowledge_names',
  'cause_primary',
  'cause_user_notes',
  'difficulty',
  'fsrs_state_due',
  'fsrs_state_reps',
  'fsrs_state_lapses',
  // ADR-0028 moves FSRS for labeled questions to the knowledge node. This column records
  // where the fsrs_state_* values came from; for labeled questions they are the most-overdue
  // knowledge node's schedule, not a per-question card.
  'fsrs_state_source_kind',
  'status',
  'last_reviewed_at',
  'review_count',
  // Dual-track judge export: effective is the latest live judge after correction resolution;
  // original is the attempt's first judge receipt. Both can differ after a re-judge.
  'judge_effective_outcome',
  'judge_original_outcome',
];

const REVIEW_HEADERS = [
  'id',
  'created_at',
  'mistake_id',
  'prompt_excerpt',
  'knowledge_names',
  'rating',
  'before_stability',
  'before_difficulty',
  'before_due',
  'before_state',
  'after_stability',
  'after_difficulty',
  'after_due',
  'after_state',
  'due_at_before',
  'due_at_next',
];

/**
 * Parse a JSON cell. Accepts an already-parsed object from drizzle or the JSON-string form
 * used in export dumps.
 */
function parseJsonCell<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

type CorrectionStatus =
  | { state: 'active'; replacement_event_id: null }
  | { state: 'retracted'; replacement_event_id: null }
  | { state: 'marked_wrong'; replacement_event_id: null }
  | { state: 'superseded'; replacement_event_id: string };

function rowId(row: Row): string {
  return String(row.id);
}

function rowCreatedAtValue(row: Row): number {
  const value = row.created_at;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function newerRow(a: Row, b: Row): boolean {
  const aTime = rowCreatedAtValue(a);
  const bTime = rowCreatedAtValue(b);
  const aSeq = Number(a.dispatch_seq ?? 0);
  const bSeq = Number(b.dispatch_seq ?? 0);
  return (
    aTime > bTime || (aTime === bTime && (aSeq > bSeq || (aSeq === bSeq && rowId(a) > rowId(b))))
  );
}

function correctionStatuses(events: Row[]): Map<string, CorrectionStatus> {
  const statuses = new Map<string, CorrectionStatus>();
  const corrections = events
    .filter((e) => e.action === 'correct' && e.subject_kind === 'event' && e.subject_id)
    .sort((a, b) => {
      if (newerRow(a, b)) return 1;
      if (newerRow(b, a)) return -1;
      return 0;
    });

  for (const correction of corrections) {
    const payload = parseJsonCell<{
      correction_kind?: string;
      replacement_event_id?: string | null;
    }>(correction.payload);
    const targetId = String(correction.subject_id);
    switch (payload?.correction_kind) {
      case 'retract':
        statuses.set(targetId, { state: 'retracted', replacement_event_id: null });
        break;
      case 'mark_wrong':
        statuses.set(targetId, { state: 'marked_wrong', replacement_event_id: null });
        break;
      case 'supersede':
        if (payload.replacement_event_id) {
          statuses.set(targetId, {
            state: 'superseded',
            replacement_event_id: payload.replacement_event_id,
          });
        }
        break;
      case 'restore':
        statuses.set(targetId, { state: 'active', replacement_event_id: null });
        break;
    }
  }

  return statuses;
}

function activeEffectiveRow(
  original: Row,
  rowsById: Map<string, Row>,
  statuses: Map<string, CorrectionStatus>,
): Row | null {
  let current = original;
  const seen = new Set<string>();

  for (let depth = 0; depth < 16; depth += 1) {
    const currentId = rowId(current);
    if (seen.has(currentId)) return null;
    seen.add(currentId);

    const status = statuses.get(currentId);
    if (!status || status.state === 'active') return current;
    if (status.state === 'retracted' || status.state === 'marked_wrong') return null;

    const replacement = rowsById.get(status.replacement_event_id);
    if (!replacement) return null;
    current = replacement;
  }

  return null;
}

/**
 * Build the mistakes CSV from the event stream: one row per failed question attempt, with
 * the effective cause, review count, and FSRS state when a matching projection exists.
 */
export function buildMistakesCsv(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    ((tables.knowledge ?? []) as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    (
      (tables.question ?? []) as Array<{
        id: string;
        prompt_md: string;
        reference_md: string | null;
        knowledge_ids?: string;
        difficulty?: number;
      }>
    ).map((q) => [q.id, q]),
  );

  const events = (tables.event ?? []) as Row[];
  const eventsById = new Map(events.filter((e) => e.id).map((e) => [rowId(e), e]));
  const statuses = correctionStatuses(events);
  const native = projectNativeCsv(
    tables,
    new Set(
      events
        .filter((event) => activeEffectiveRow(event, eventsById, statuses)?.id === event.id)
        .map(rowId),
    ),
  );
  const attempts = events.filter(
    (e) => e.action === 'attempt' && e.subject_kind === 'question' && e.outcome === 'failure',
  );
  // Index active/effective cause events by caused_by_event_id for chained lookup.
  const judgesByAttempt = new Map<string, Row>();
  const userCausesByAttempt = new Map<string, Row>();
  // Original judge track: the attempt's earliest raw judge row; corrections do not rewrite it.
  const originalJudgeByAttempt = new Map<string, Row>();
  const nativeAttemptIds = new Set(native.attempts.map((attempt) => attempt.id));
  for (const e of events) {
    const nativeAttemptId =
      typeof e.subject_id === 'string' && nativeAttemptIds.has(e.subject_id)
        ? e.subject_id
        : typeof e.caused_by_event_id === 'string' && nativeAttemptIds.has(e.caused_by_event_id)
          ? e.caused_by_event_id
          : null;
    const attemptId =
      nativeAttemptId ?? (e.caused_by_event_id ? String(e.caused_by_event_id) : null);
    if (
      (e.action === 'judge' || e.action === 'experimental:user_cause') &&
      e.subject_kind === 'event' &&
      attemptId
    ) {
      const effective = activeEffectiveRow(e, eventsById, statuses);
      if (
        !effective ||
        effective.action !== e.action ||
        effective.subject_kind !== e.subject_kind ||
        effective.subject_id !== e.subject_id ||
        (!nativeAttemptId && effective.caused_by_event_id !== e.caused_by_event_id)
      ) {
        continue;
      }
      const bucket = e.action === 'judge' ? judgesByAttempt : userCausesByAttempt;
      const existing = bucket.get(attemptId);
      if (!existing || newerRow(effective, existing)) {
        bucket.set(attemptId, effective);
      }
      // Original track: keep the earliest judge receipt, untouched by re-judging.
      if (e.action === 'judge') {
        const prev = originalJudgeByAttempt.get(attemptId);
        if (!prev || newerRow(prev, e)) {
          originalJudgeByAttempt.set(attemptId, e);
        }
      }
    }
  }
  const reviewsByQuestion = new Map<string, Row[]>();
  for (const e of events) {
    if (e.action === 'review' && e.subject_kind === 'question') {
      const qid = e.subject_id as string;
      const list = reviewsByQuestion.get(qid) ?? [];
      list.push(e);
      reviewsByQuestion.set(qid, list);
    }
  }
  // Index FSRS state by subject. Post-ADR-0028 a labeled question's projection lives under
  // subject_kind='knowledge'; index both so it can fall back to the knowledge schedule.
  const fsrsByQuestion = new Map<string, Row>();
  const fsrsByKnowledge = new Map<string, Row>();
  for (const r of (tables.material_fsrs_state ?? []) as Row[]) {
    if (r.subject_kind === 'question') {
      fsrsByQuestion.set(r.subject_id as string, r);
    } else if (r.subject_kind === 'knowledge') {
      fsrsByKnowledge.set(r.subject_id as string, r);
    }
  }

  // Resolve which FSRS row to report: a question-level row wins; otherwise pick the
  // most-overdue knowledge-level row among the question's ids. The source kind is returned
  // so the row can label provenance without faking a per-question card.
  function resolveFsrsForQuestion(
    qid: string,
    knowledgeIds: string[],
  ): { row: Row; kind: 'question' | 'knowledge' } | null {
    const own = fsrsByQuestion.get(qid);
    if (own) return { row: own, kind: 'question' };
    let best: Row | null = null;
    let bestDue = Number.POSITIVE_INFINITY;
    for (const kid of knowledgeIds) {
      const krow = fsrsByKnowledge.get(kid);
      if (!krow) continue;
      const state = parseJsonCell<{ due?: number | string }>(krow.state);
      const dueRaw = state?.due;
      const due =
        typeof dueRaw === 'number'
          ? dueRaw
          : typeof dueRaw === 'string'
            ? Date.parse(dueRaw)
            : Number.POSITIVE_INFINITY;
      const dueValue = Number.isFinite(due) ? due : Number.POSITIVE_INFINITY;
      if (best === null || dueValue < bestDue) {
        best = krow;
        bestDue = dueValue;
      }
    }
    return best ? { row: best, kind: 'knowledge' } : null;
  }

  function questionKnowledgeIds(q: { knowledge_ids?: string | string[] } | undefined): string[] {
    if (!q?.knowledge_ids) return [];
    if (Array.isArray(q.knowledge_ids)) return q.knowledge_ids;
    return parseJsonCell<string[]>(q.knowledge_ids) ?? [];
  }

  const lines: string[] = [MISTAKES_HEADERS.join(',')];

  function reviewStats(qid: string) {
    const legacy = reviewsByQuestion.get(qid) ?? [];
    const current = native.reviews.filter((review) => review.questionIds.includes(qid));
    const times = [
      ...legacy.map(rowCreatedAtValue),
      ...current.map((review) => review.occurredAt.getTime()),
    ];
    return {
      count: legacy.length + current.length,
      last: times.length ? Math.max(...times) : null,
    };
  }

  for (const a of attempts) {
    const qid = a.subject_id as string;
    const q = questionById.get(qid);
    const attemptPayload = parseJsonCell<{
      answer_md: string | null;
      answer_image_refs: string[];
      referenced_knowledge_ids: string[];
    }>(a.payload);
    const knowledgeIds = attemptPayload?.referenced_knowledge_ids ?? [];
    const kNames = knowledgeIds.map((id) => knowledgeById.get(id) ?? id).join('; ');

    const userCause = userCausesByAttempt.get(rowId(a));
    const userCausePayload = userCause
      ? parseJsonCell<{
          primary_category: string;
          user_notes?: string | null;
        }>(userCause.payload)
      : null;
    const judge = judgesByAttempt.get(rowId(a));
    const judgePayload = judge
      ? parseJsonCell<{
          cause: { primary_category: string; analysis_md: string; confidence: number };
          coarse_outcome?: string | null;
        }>(judge.payload)
      : null;
    // Original judge receipt for the dual-track export; corrections keep the first result.
    const originalJudge = originalJudgeByAttempt.get(rowId(a));
    const originalJudgePayload = originalJudge
      ? parseJsonCell<{ coarse_outcome?: string | null }>(originalJudge.payload)
      : null;
    const causePrimary =
      userCausePayload?.primary_category ?? judgePayload?.cause?.primary_category ?? '';
    const causeUserNotes = userCausePayload?.user_notes ?? '';

    const reviews = reviewStats(qid);

    // Include knowledge-level FSRS rows. The attempt's referenced ids are unioned with the
    // question's stored ids so a labeled question resolves even with no referenced ids.
    const fsrsKnowledgeIds = Array.from(new Set([...knowledgeIds, ...questionKnowledgeIds(q)]));
    const fsrsResolved = resolveFsrsForQuestion(qid, fsrsKnowledgeIds);
    const fsrsState = fsrsResolved
      ? parseJsonCell<{ due: number; reps: number; lapses: number }>(fsrsResolved.row.state)
      : null;
    const fsrsSourceKind = fsrsResolved?.kind ?? '';

    lines.push(
      [
        csvEscape(a.id),
        csvEscape(a.created_at),
        csvEscape(q?.prompt_md ?? ''),
        csvEscape(q?.reference_md ?? ''),
        csvEscape(attemptPayload?.answer_md ?? ''),
        csvEscape(kNames),
        csvEscape(causePrimary),
        csvEscape(causeUserNotes),
        csvEscape(q?.difficulty ?? ''),
        csvEscape(fsrsState?.due ?? ''),
        csvEscape(fsrsState?.reps ?? ''),
        csvEscape(fsrsState?.lapses ?? ''),
        csvEscape(fsrsSourceKind),
        // No mistake.status equivalent in the event stream; a failure without an archive
        // event is active.
        csvEscape('active'),
        csvEscape(reviews.last ?? ''),
        csvEscape(reviews.count),
        csvEscape(judgePayload?.coarse_outcome ?? ''),
        csvEscape(originalJudgePayload?.coarse_outcome ?? ''),
      ].join(','),
    );
  }

  const coarse = (outcome: string) =>
    outcome === 'success'
      ? 'correct'
      : outcome === 'failure'
        ? 'incorrect'
        : outcome === 'unsupported'
          ? 'unknown'
          : outcome;
  for (const attempt of native.attempts) {
    if (attempt.originalOutcome !== 'failure' && attempt.effectiveOutcome !== 'failure') continue;
    const user = userCausesByAttempt.get(attempt.id);
    const judge = judgesByAttempt.get(attempt.id);
    const userParsed = z
      .object({ primary_category: z.string(), user_notes: z.string().nullable().optional() })
      .safeParse(parseJsonCell<unknown>(user?.payload));
    const judgeParsed = z
      .object({ cause: z.object({ primary_category: z.string() }).nullish() })
      .safeParse(parseJsonCell<unknown>(judge?.payload));
    const userPayload = userParsed.success ? userParsed.data : null;
    const judgePayload = judgeParsed.success ? judgeParsed.data : null;
    const schedule = resolveFsrsForQuestion(attempt.questionId, attempt.knowledgeIds);
    const stateParsed = SchedulingStateSchema.safeParse(
      parseJsonCell<unknown>(schedule?.row.state),
    );
    const state = stateParsed.success ? stateParsed.data : null;
    const reviews = reviewStats(attempt.questionId);
    lines.push(
      [
        attempt.id,
        attempt.createdAt.toISOString(),
        attempt.prompt,
        attempt.reference,
        attempt.response,
        attempt.knowledgeIds.map((id) => knowledgeById.get(id) ?? id).join('; '),
        userPayload?.primary_category ?? judgePayload?.cause?.primary_category ?? '',
        userPayload?.user_notes ?? '',
        attempt.difficulty ?? '',
        state?.due.toISOString() ?? '',
        state && !isCandidateState(state) ? state.reps : '',
        state && !isCandidateState(state) ? state.lapses : '',
        schedule?.kind ?? '',
        'active',
        reviews.last ?? '',
        reviews.count,
        coarse(attempt.effectiveOutcome),
        coarse(attempt.originalOutcome),
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  return lines.join('\n');
}

/**
 * Build the review-events CSV from the event stream: one row per question review event.
 * Before-state columns are blank because the review event no longer carries them.
 */
export function buildReviewEventsCsv(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    ((tables.knowledge ?? []) as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    (
      (tables.question ?? []) as Array<{
        id: string;
        prompt_md: string;
        // knowledge_ids is jsonb: the driver returns string[], legacy dumps a JSON string.
        knowledge_ids?: string | string[];
      }>
    ).map((q) => [q.id, q]),
  );

  const events = (tables.event ?? []) as Row[];
  const eventsById = new Map(events.filter((e) => e.id).map((e) => [rowId(e), e]));
  const statuses = correctionStatuses(events);
  const native = projectNativeCsv(
    tables,
    new Set(
      events
        .filter((event) => activeEffectiveRow(event, eventsById, statuses)?.id === event.id)
        .map(rowId),
    ),
  );
  const reviews = events.filter((e) => e.action === 'review' && e.subject_kind === 'question');

  const lines: string[] = [REVIEW_HEADERS.join(',')];

  for (const r of reviews) {
    const qid = r.subject_id as string;
    const question = questionById.get(qid);
    // Accept both jsonb shapes: a parsed array and the legacy JSON string.
    const kIds: string[] = Array.isArray(question?.knowledge_ids)
      ? question.knowledge_ids
      : (parseJsonCell<string[]>(question?.knowledge_ids) ?? []);
    const kNames = kIds.map((id) => knowledgeById.get(id) ?? id).join('; ');
    const promptExcerpt = (question?.prompt_md ?? '').slice(0, 80).replace(/[\n\r]/g, ' ');
    const payload = parseJsonCell<{
      fsrs_rating: 'again' | 'hard' | 'good';
      fsrs_state_after: {
        stability: number;
        difficulty: number;
        due: number;
        state: string;
      };
    }>(r.payload);
    const after = payload?.fsrs_state_after ?? null;

    lines.push(
      [
        csvEscape(r.id),
        csvEscape(r.created_at),
        // No mistake_id in the event-stream model — blank.
        csvEscape(''),
        csvEscape(promptExcerpt),
        csvEscape(kNames),
        csvEscape(payload?.fsrs_rating ?? ''),
        // before_* blank — the event no longer carries fsrs_state_before.
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(after?.stability ?? ''),
        csvEscape(after?.difficulty ?? ''),
        csvEscape(after?.due ?? ''),
        csvEscape(after?.state ?? ''),
        // due_at_before / due_at_next blank — those columns were dropped too.
        csvEscape(''),
        csvEscape(''),
      ].join(','),
    );
  }

  for (const review of native.reviews) {
    lines.push(
      [
        review.id,
        review.occurredAt.toISOString(),
        '',
        review.prompt.slice(0, 80).replace(/[\n\r]/g, ' '),
        review.knowledgeIds.map((id) => knowledgeById.get(id) ?? id).join('; '),
        review.rating,
        review.before && !isCandidateState(review.before) ? review.before.stability : '',
        review.before && !isCandidateState(review.before) ? review.before.difficulty : '',
        review.before?.due.toISOString() ?? '',
        review.before && !isCandidateState(review.before) ? review.before.state : '',
        review.after && !isCandidateState(review.after) ? review.after.stability : '',
        review.after && !isCandidateState(review.after) ? review.after.difficulty : '',
        review.after?.due.toISOString() ?? '',
        review.after && !isCandidateState(review.after) ? review.after.state : '',
        review.before?.due.toISOString() ?? '',
        review.after?.due.toISOString() ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  return lines.join('\n');
}
