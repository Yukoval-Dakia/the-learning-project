// YUK-1473 — the 「做错过」 read: today's GET /api/mistakes rows mapped onto the planned
// per-question summary (effective_wrong_attempt_count, last_effective_wrong_at, primary_cause,
// attribution_state). PARTIAL VIEW until /api/questions carries that summary (`has_mistake`):
// pages arrive by cursor, so the number of questions shown is "loaded so far", never a total.
//
// Rules kept here, not in components:
// - rows are HISTORY ("做错过的记录"), not "currently wrong": a row whose judgement was later
//   reverted still appears, and nothing here says the answer is wrong now;
// - group by question_id only; each mistake row counts once, even across page boundaries;
// - a row counts as an effective wrong attempt only while its correction chain ends 'active';
// - no "corrected / relearned" state: there is no authoritative read model for it. The only
//   correction shown is a real grading-correction fact (marked_wrong → 「判分已更正」);
//   "later answered it right on my own" is not shown until the backend provides it;
// - a missing cause is 'unknown' (「原因还不确定」), never an in-progress state, never guessed.

import type { MistakeRow } from './library-api';

/** What the correction chain says about one record. */
export type RecordStanding =
  /** The record stands as a wrong attempt. */
  | 'stands'
  /** The grading was corrected: the judgement of "wrong" was marked as a mistake. */
  | 'grading_corrected'
  /** The record was withdrawn. */
  | 'withdrawn'
  /** The chain could not be resolved. */
  | 'unknown';

export function recordStanding(row: MistakeRow): RecordStanding {
  switch (row.correction_state.terminal_state) {
    case 'active':
      return 'stands';
    case 'marked_wrong':
      return 'grading_corrected';
    case 'retracted':
      return 'withdrawn';
    default:
      return 'unknown';
  }
}

export interface MistakeCause {
  by: 'ai' | 'me';
  category: string;
  /** Display label resolved by the API (misconception title), if any. */
  label: string | null;
  note: string | null;
}

export interface MistakeRecord {
  id: string;
  createdAtSec: number;
  /** The prompt as it was when this attempt happened (frozen per record). */
  promptMd: string;
  wrongAnswerMd: string;
  wrongAnswerImages: readonly string[];
  cause: MistakeCause | null;
  standing: RecordStanding;
}

/** The planned per-question summary, filled from the records loaded so far. */
export interface MistakeQuestionSummary {
  question_id: string;
  effective_wrong_attempt_count: number;
  last_effective_wrong_at: number | null;
  primary_cause: MistakeCause | null;
  attribution_state: 'attributed' | 'unknown';
}

export interface MistakeQuestion {
  summary: MistakeQuestionSummary;
  /** Newest record's prompt (for recognising the question in a list). */
  promptMd: string;
  knowledgeIds: readonly string[];
  /** Newest first; every record, including ones whose grading was corrected. */
  records: MistakeRecord[];
  latestRecordAtSec: number;
}

function toRecord(row: MistakeRow): MistakeRecord {
  return {
    id: row.id,
    createdAtSec: row.created_at,
    promptMd: row.prompt_md,
    wrongAnswerMd: row.wrong_answer_md,
    wrongAnswerImages: row.wrong_answer_image_refs,
    cause: row.cause
      ? {
          by: row.cause.source === 'user' ? 'me' : 'ai',
          category: row.cause.primary_category,
          label: row.cause.primary_label,
          note: row.cause.user_notes,
        }
      : null,
    standing: recordStanding(row),
  };
}

function summarise(questionId: string, records: readonly MistakeRecord[]): MistakeQuestionSummary {
  const effective = records.filter((r) => r.standing === 'stands');
  const latest = effective[0] ?? null;
  return {
    question_id: questionId,
    effective_wrong_attempt_count: effective.length,
    last_effective_wrong_at: latest?.createdAtSec ?? null,
    primary_cause: latest?.cause ?? null,
    attribution_state: latest?.cause ? 'attributed' : 'unknown',
  };
}

/** Group loaded mistake rows (any number of pages, in API order) by question_id. */
export function groupMistakes(rows: readonly MistakeRow[]): MistakeQuestion[] {
  const seen = new Set<string>();
  const byQuestion = new Map<string, { rows: MistakeRow[] }>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const group = byQuestion.get(row.question_id);
    if (group) group.rows.push(row);
    else byQuestion.set(row.question_id, { rows: [row] });
  }
  const groups: MistakeQuestion[] = [];
  for (const [questionId, group] of byQuestion) {
    const records = group.rows.map(toRecord).sort((a, b) => b.createdAtSec - a.createdAtSec);
    const newest = group.rows.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    groups.push({
      summary: summarise(questionId, records),
      promptMd: newest.prompt_md,
      knowledgeIds: newest.knowledge_ids,
      records,
      latestRecordAtSec: newest.created_at,
    });
  }
  return groups.sort((a, b) => b.latestRecordAtSec - a.latestRecordAtSec);
}

/**
 * Split by what the records say: some record still stands; every record's grading was corrected
 * (the only case labelled 「判分已更正」); or the rest (withdrawn / unresolved records).
 */
export function splitByEffect(groups: readonly MistakeQuestion[]) {
  const standing: MistakeQuestion[] = [];
  const gradingCorrected: MistakeQuestion[] = [];
  const other: MistakeQuestion[] = [];
  for (const group of groups) {
    if (group.summary.effective_wrong_attempt_count > 0) standing.push(group);
    else if (group.records.every((r) => r.standing === 'grading_corrected'))
      gradingCorrected.push(group);
    else other.push(group);
  }
  return { standing, gradingCorrected, other };
}

/** A state word for one record, only where there is a fact to state. */
export const RECORD_WORDS: Readonly<Record<RecordStanding, string | null>> = {
  stands: null,
  grading_corrected: '判分已更正',
  withdrawn: '这条记录已撤回',
  unknown: '状态还不确定',
};

export function causeWords(cause: MistakeCause | null, labelFor: (id: string) => string): string {
  if (!cause) return '原因还不确定';
  const name = cause.label ?? labelFor(cause.category);
  return `${name} · ${cause.by === 'me' ? '我标的' : 'AI 判断'}`;
}
