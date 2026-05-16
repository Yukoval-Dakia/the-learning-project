// Phase 1c.1 Step 4 — CSV exporters with dual-path support.
//
// Both buildMistakesCsv and buildReviewEventsCsv branch at function entry:
//   - if legacy `tables.mistake[]` (or `tables.review_event[]`) is non-empty,
//     use the legacy path (back-compat for pre-1c.1 exports).
//   - else, project from `tables.event[]` into mistake-shape / review-shape.
//
// Precedence rule documented inline. Step 6 will tighten the export route so
// only one source flows in at a time; Step 9 removes the legacy path entirely.

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
 * Returns null when input is null/undefined.
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

export function buildMistakesCsv(tables: Record<string, Row[]>): string {
  const legacy = (tables.mistake ?? []) as Row[];
  // Precedence: legacy mistake[] non-empty wins → use legacy path. Else event projection.
  if (legacy.length > 0) {
    return buildMistakesCsvLegacy(tables);
  }
  return buildMistakesCsvFromEvents(tables);
}

function buildMistakesCsvLegacy(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    (tables.knowledge as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    (tables.question as Array<{ id: string; prompt_md: string; reference_md: string | null }>).map(
      (q) => [q.id, q],
    ),
  );
  const reviewsByMistake = new Map<string, Row[]>();
  for (const r of (tables.review_event ?? []) as Row[]) {
    const list = reviewsByMistake.get(r.mistake_id as string) ?? [];
    list.push(r);
    reviewsByMistake.set(r.mistake_id as string, list);
  }

  const lines: string[] = [MISTAKES_HEADERS.join(',')];

  for (const m of (tables.mistake ?? []) as Row[]) {
    const q = questionById.get(m.question_id as string);
    const kIdsRaw = m.knowledge_ids as string | null | undefined;
    const kIds: string[] = kIdsRaw ? (JSON.parse(kIdsRaw) as string[]) : [];
    const kNames = kIds.map((id) => knowledgeById.get(id) ?? id).join('; ');
    const cause = m.cause
      ? (JSON.parse(m.cause as string) as {
          primary_category: string;
          user_notes: string | null;
        })
      : null;
    const fsrs = m.fsrs_state
      ? (JSON.parse(m.fsrs_state as string) as {
          due: number;
          reps: number;
          lapses: number;
        })
      : null;
    const reviews = reviewsByMistake.get(m.id as string) ?? [];
    const lastReview =
      reviews.length > 0 ? Math.max(...reviews.map((r) => r.created_at as number)) : null;

    lines.push(
      [
        csvEscape(m.id),
        csvEscape(m.created_at),
        csvEscape(q?.prompt_md ?? ''),
        csvEscape(q?.reference_md ?? ''),
        csvEscape(m.wrong_answer_md),
        csvEscape(kNames),
        csvEscape(cause?.primary_category ?? ''),
        csvEscape(cause?.user_notes ?? ''),
        csvEscape((q as { difficulty?: number } | undefined)?.difficulty ?? ''),
        csvEscape(fsrs?.due ?? ''),
        csvEscape(fsrs?.reps ?? ''),
        csvEscape(fsrs?.lapses ?? ''),
        csvEscape(m.status),
        csvEscape(lastReview ?? ''),
        csvEscape(reviews.length),
      ].join(','),
    );
  }

  return lines.join('\n');
}

/**
 * Event-stream projection: synthesize mistake-shape rows from the event log.
 *   - One row per `event(action='attempt', outcome='failure', subject_kind='question')`
 *   - cause comes from chained `event(action='judge', caused_by_event_id=attempt.id)`
 *   - review_count comes from `event(action='review', subject_id=question_id)` for the same question
 *     (note: in the event model reviews target the question directly, not the attempt;
 *     legacy behaviour counted reviews per mistake.id — closest equivalent post-Step-4
 *     is reviews on the same question, which we use.)
 *   - fsrs_state comes from the matching `material_fsrs_state` row (when present).
 */
function buildMistakesCsvFromEvents(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    ((tables.knowledge ?? []) as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    ((tables.question ?? []) as Array<{
      id: string;
      prompt_md: string;
      reference_md: string | null;
      knowledge_ids?: string;
      difficulty?: number;
    }>).map((q) => [q.id, q]),
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

export function buildReviewEventsCsv(tables: Record<string, Row[]>): string {
  const legacy = (tables.review_event ?? []) as Row[];
  // Precedence: legacy review_event[] non-empty wins → use legacy path. Else event projection.
  if (legacy.length > 0) {
    return buildReviewEventsCsvLegacy(tables);
  }
  return buildReviewEventsCsvFromEvents(tables);
}

function buildReviewEventsCsvLegacy(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    (tables.knowledge as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    (tables.question as Array<{ id: string; prompt_md: string; knowledge_ids: string }>).map(
      (q) => [q.id, q],
    ),
  );
  const mistakeById = new Map(
    (tables.mistake as Array<{ id: string; question_id: string }>).map((m) => [m.id, m]),
  );

  const lines: string[] = [REVIEW_HEADERS.join(',')];

  for (const r of (tables.review_event ?? []) as Row[]) {
    const mistake = mistakeById.get(r.mistake_id as string);
    const question = mistake ? questionById.get(mistake.question_id) : undefined;
    const kIds: string[] = question ? (JSON.parse(question.knowledge_ids) as string[]) : [];
    const kNames = kIds.map((id) => knowledgeById.get(id) ?? id).join('; ');
    const promptExcerpt = (question?.prompt_md ?? '').slice(0, 80).replace(/[\n\r]/g, ' ');
    const before = r.fsrs_state_before ? JSON.parse(r.fsrs_state_before as string) : null;
    const after = r.fsrs_state_after ? JSON.parse(r.fsrs_state_after as string) : null;

    lines.push(
      [
        csvEscape(r.id),
        csvEscape(r.created_at),
        csvEscape(r.mistake_id),
        csvEscape(promptExcerpt),
        csvEscape(kNames),
        csvEscape(r.rating),
        csvEscape(before?.stability ?? ''),
        csvEscape(before?.difficulty ?? ''),
        csvEscape(before?.due ?? ''),
        csvEscape(before?.state ?? ''),
        csvEscape(after?.stability ?? ''),
        csvEscape(after?.difficulty ?? ''),
        csvEscape(after?.due ?? ''),
        csvEscape(after?.state ?? ''),
        csvEscape(r.due_at_before ?? ''),
        csvEscape(r.due_at_next ?? ''),
      ].join(','),
    );
  }

  return lines.join('\n');
}

/**
 * Event-stream projection for review events:
 *   - One row per `event(action='review', subject_kind='question')`
 *   - mistake_id is null (event review targets question directly); blank in CSV
 *   - before_* columns are blank — Lane B's ReviewOnQuestion intentionally dropped
 *     fsrs_state_before; only fsrs_state_after is captured (Step 3 migration noted
 *     forensic data lives in the legacy review_event table).
 */
function buildReviewEventsCsvFromEvents(tables: Record<string, Row[]>): string {
  const knowledgeById = new Map(
    ((tables.knowledge ?? []) as Array<{ id: string; name: string }>).map((k) => [k.id, k.name]),
  );
  const questionById = new Map(
    ((tables.question ?? []) as Array<{
      id: string;
      prompt_md: string;
      knowledge_ids?: string;
    }>).map((q) => [q.id, q]),
  );

  const events = (tables.event ?? []) as Row[];
  const reviews = events.filter(
    (e) => e.action === 'review' && e.subject_kind === 'question',
  );

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
