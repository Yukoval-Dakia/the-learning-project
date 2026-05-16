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

/**
 * Build the mistakes CSV from the event stream:
 *   - One row per `event(action='attempt', outcome='failure', subject_kind='question')`
 *   - cause comes from chained `event(action='judge', caused_by_event_id=attempt.id)`
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
  const attempts = events.filter(
    (e) => e.action === 'attempt' && e.subject_kind === 'question' && e.outcome === 'failure',
  );
  // Index judges by caused_by_event_id for chained lookup
  const judgesByAttempt = new Map<string, Row>();
  for (const e of events) {
    if (e.action === 'judge' && e.subject_kind === 'event' && e.caused_by_event_id) {
      judgesByAttempt.set(e.caused_by_event_id as string, e);
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

    const judge = judgesByAttempt.get(a.id as string);
    const judgePayload = judge
      ? parseJsonCell<{
          cause: { primary_category: string; analysis_md: string; confidence: number };
        }>(judge.payload)
      : null;
    const cause = judgePayload?.cause ?? null;

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
        // No user_notes in event-stream cause (Lane B dropped that field — analysis_md replaces it)
        csvEscape(cause?.primary_category ?? ''),
        csvEscape(''),
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
