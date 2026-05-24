// Phase 1c.1 Step 9.E — CSV exporters over the event stream only.
//
// Pre-Step-9: dual-path — `tables.mistake[]` / `tables.review_event[]` (legacy)
// vs `tables.event[]` projection. Post-Step-9 the legacy tables are gone;
// the only source is `tables.event[]` + `tables.material_fsrs_state[]`.

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
  'status',
  'last_reviewed_at',
  'review_count',
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
 * Parse a JSON cell value. Accepts the raw row (e.g. drizzle returning the
 * object already) and the JSON-string-encoded form used in export dumps.
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
  return aTime > bTime || (aTime === bTime && rowId(a) > rowId(b));
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
 * Build the mistakes CSV from the event stream:
 *   - One row per `event(action='attempt', outcome='failure', subject_kind='question')`
 *   - cause comes from the effective chained user_cause first, then judge
 *   - review_count counts `event(action='review', subject_id=question_id)` for the same question
 *   - fsrs_state comes from the matching `material_fsrs_state` row (when present).
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
  const attempts = events.filter(
    (e) => e.action === 'attempt' && e.subject_kind === 'question' && e.outcome === 'failure',
  );
  // Index active/effective cause events by caused_by_event_id for chained lookup.
  const judgesByAttempt = new Map<string, Row>();
  const userCausesByAttempt = new Map<string, Row>();
  for (const e of events) {
    if (
      (e.action === 'judge' || e.action === 'experimental:user_cause') &&
      e.subject_kind === 'event' &&
      e.caused_by_event_id
    ) {
      const effective = activeEffectiveRow(e, eventsById, statuses);
      if (
        !effective ||
        effective.action !== e.action ||
        effective.subject_kind !== e.subject_kind ||
        effective.subject_id !== e.subject_id ||
        effective.caused_by_event_id !== e.caused_by_event_id
      ) {
        continue;
      }
      const bucket = e.action === 'judge' ? judgesByAttempt : userCausesByAttempt;
      const attemptId = String(e.caused_by_event_id);
      const existing = bucket.get(attemptId);
      if (!existing || newerRow(effective, existing)) {
        bucket.set(attemptId, effective);
      }
    }
  }
  // Index reviews per question
  const reviewsByQuestion = new Map<string, Row[]>();
  for (const e of events) {
    if (e.action === 'review' && e.subject_kind === 'question') {
      const qid = e.subject_id as string;
      const list = reviewsByQuestion.get(qid) ?? [];
      list.push(e);
      reviewsByQuestion.set(qid, list);
    }
  }
  // Index FSRS state per (subject_kind, subject_id) — keyed by question_id here
  const fsrsByQuestion = new Map<string, Row>();
  for (const r of (tables.material_fsrs_state ?? []) as Row[]) {
    if (r.subject_kind === 'question') {
      fsrsByQuestion.set(r.subject_id as string, r);
    }
  }

  const lines: string[] = [MISTAKES_HEADERS.join(',')];

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
        }>(judge.payload)
      : null;
    const causePrimary =
      userCausePayload?.primary_category ?? judgePayload?.cause.primary_category ?? '';
    const causeUserNotes = userCausePayload?.user_notes ?? '';

    const reviews = reviewsByQuestion.get(qid) ?? [];
    const lastReview =
      reviews.length > 0 ? Math.max(...reviews.map((r) => r.created_at as number)) : null;

    const fsrsRow = fsrsByQuestion.get(qid);
    const fsrsState = fsrsRow
      ? parseJsonCell<{ due: number; reps: number; lapses: number }>(fsrsRow.state)
      : null;

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
        // No mistake.status equivalent in event stream — emit 'active' since
        // a failure attempt without an archive event is considered active.
        csvEscape('active'),
        csvEscape(lastReview ?? ''),
        csvEscape(reviews.length),
      ].join(','),
    );
  }

  return lines.join('\n');
}

/**
 * Build the review-events CSV from the event stream:
 *   - One row per `event(action='review', subject_kind='question')`
 *   - mistake_id is null (event review targets question directly); blank in CSV
 *   - before_* columns blank — Lane B's ReviewOnQuestion dropped fsrs_state_before
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
        knowledge_ids?: string;
      }>
    ).map((q) => [q.id, q]),
  );

  const events = (tables.event ?? []) as Row[];
  const reviews = events.filter((e) => e.action === 'review' && e.subject_kind === 'question');

  const lines: string[] = [REVIEW_HEADERS.join(',')];

  for (const r of reviews) {
    const qid = r.subject_id as string;
    const question = questionById.get(qid);
    const kIds: string[] = question?.knowledge_ids
      ? (JSON.parse(question.knowledge_ids) as string[])
      : [];
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
        // No mistake_id in event-stream model — blank
        csvEscape(''),
        csvEscape(promptExcerpt),
        csvEscape(kNames),
        csvEscape(payload?.fsrs_rating ?? ''),
        // before_* blank — Lane B drops fsrs_state_before
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(after?.stability ?? ''),
        csvEscape(after?.difficulty ?? ''),
        csvEscape(after?.due ?? ''),
        csvEscape(after?.state ?? ''),
        // due_at_before / due_at_next blank — separate timestamp columns also dropped
        csvEscape(''),
        csvEscape(''),
      ].join(','),
    );
  }

  return lines.join('\n');
}
