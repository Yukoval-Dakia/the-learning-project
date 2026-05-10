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

export function buildMistakesCsv(tables: Record<string, Row[]>): string {
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

  const headers = [
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

  const lines: string[] = [headers.join(',')];

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
      reviews.length > 0 ? Math.max(...reviews.map((r) => r.rated_at as number)) : null;

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
        csvEscape((m as { difficulty?: number }).difficulty),
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

export function buildReviewEventsCsv(tables: Record<string, Row[]>): string {
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

  const RATING_LABEL: Record<number, string> = { 1: 'again', 2: 'hard', 3: 'good' };

  const headers = [
    'id',
    'rated_at',
    'mistake_id',
    'prompt_excerpt',
    'knowledge_names',
    'rating',
    'rating_label',
    'before_stability',
    'before_difficulty',
    'before_due',
    'before_state',
    'after_stability',
    'after_difficulty',
    'after_due',
    'after_state',
  ];

  const lines: string[] = [headers.join(',')];

  for (const r of (tables.review_event ?? []) as Row[]) {
    const mistake = mistakeById.get(r.mistake_id as string);
    const question = mistake ? questionById.get(mistake.question_id) : undefined;
    const kIds: string[] = question ? (JSON.parse(question.knowledge_ids) as string[]) : [];
    const kNames = kIds.map((id) => knowledgeById.get(id) ?? id).join('; ');
    const promptExcerpt = (question?.prompt_md ?? '').slice(0, 80).replace(/[\n\r]/g, ' ');
    const before = r.before_fsrs_state ? JSON.parse(r.before_fsrs_state as string) : null;
    const after = r.after_fsrs_state ? JSON.parse(r.after_fsrs_state as string) : null;

    lines.push(
      [
        csvEscape(r.id),
        csvEscape(r.rated_at),
        csvEscape(r.mistake_id),
        csvEscape(promptExcerpt),
        csvEscape(kNames),
        csvEscape(r.rating),
        csvEscape(RATING_LABEL[r.rating as number] ?? ''),
        csvEscape(before?.stability ?? ''),
        csvEscape(before?.difficulty ?? ''),
        csvEscape(before?.due ?? ''),
        csvEscape(before?.state ?? ''),
        csvEscape(after?.stability ?? ''),
        csvEscape(after?.difficulty ?? ''),
        csvEscape(after?.due ?? ''),
        csvEscape(after?.state ?? ''),
      ].join(','),
    );
  }

  return lines.join('\n');
}
