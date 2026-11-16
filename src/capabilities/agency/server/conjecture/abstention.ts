// Prior research-meeting abstentions. A cell is the same (cause × knowledge) key.
//
// New evidence is a failure attempt id in tonight's cell that is not in the
// abstention's seen set (`input_evidence_event_ids` — the ids already considered).
// The same ids again are not new, even if they are still inside the recency window.
// Only a semantic abstention (event outcome `partial`) can skip a cell. An
// operational abstention (outcome `failure`) is a run that did not finish, so the
// cell stays eligible.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';

const ABSTENTION_ACTION = 'experimental:conjecture_abstained';
const ABSTENTION_QUERY_CHUNK = 500;
const ABSTENTION_ROW_CAP = 500;

export interface SemanticAbstention {
  cell_key: string;
  abstained_at: Date;
  /** Failure attempt ids the meeting had already considered. */
  seen_failure_attempt_ids: readonly string[];
  reason_code: string;
  explanation_md: string | null;
}

/** Failure attempt ids that were not in the abstention's seen set. */
export interface NewFailureAttemptEvidence {
  readonly kind: 'new_failure_attempt_ids';
  readonly attempt_ids: readonly string[];
}

export interface ReopenedAbstention {
  reason_code: string;
  explanation_md: string | null;
  seen_failure_attempt_ids: readonly string[];
  new_failure_attempt_ids: readonly string[];
}

export type AbstentionReplay =
  | { kind: 'no_prior_abstention' }
  | { kind: 'skip_unchanged' }
  | ({ kind: 'reopen' } & ReopenedAbstention & { new_evidence: NewFailureAttemptEvidence });

export interface AbstentionCellRef {
  key: string;
  knowledge_id: string;
  evidence_event_ids: readonly string[];
}

interface ParsedAbstention {
  knowledge_id: string;
  cell_key: string | null;
  abstained_at: Date;
  seen_failure_attempt_ids: readonly string[];
  reason_code: string;
  explanation_md: string | null;
  semantic: boolean;
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function parseAbstention(row: {
  subject_id: string;
  created_at: Date;
  outcome: string | null;
  payload: unknown;
}): ParsedAbstention | null {
  const payload =
    row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  if (!payload) return null;
  const reason = payload.reason_code;
  if (typeof reason !== 'string' || reason.length === 0) return null;
  const cellKey = payload.cell_key;
  const explanation = payload.explanation_md;
  return {
    knowledge_id: row.subject_id,
    cell_key: typeof cellKey === 'string' && cellKey.length > 0 ? cellKey : null,
    abstained_at: row.created_at,
    seen_failure_attempt_ids: stringIds(payload.input_evidence_event_ids),
    reason_code: reason,
    explanation_md: typeof explanation === 'string' ? explanation : null,
    semantic: row.outcome === 'partial',
  };
}

/**
 * Bind one stored abstention to tonight's cell.
 * A stored `cell_key` matches only that key. Older rows omit it; they bind only
 * when their seen failure ids intersect exactly one candidate on the same knowledge point.
 */
export function attributeAbstentionCellKey(
  record: {
    cell_key: string | null;
    knowledge_id: string;
    seen_failure_attempt_ids: readonly string[];
  },
  cells: readonly AbstentionCellRef[],
): string | null {
  if (record.cell_key) {
    return cells.some((cell) => cell.key === record.cell_key) ? record.cell_key : null;
  }
  const seen = new Set(record.seen_failure_attempt_ids);
  const hits = cells.filter(
    (cell) =>
      cell.knowledge_id === record.knowledge_id &&
      cell.evidence_event_ids.some((id) => seen.has(id)),
  );
  return hits.length === 1 ? hits[0].key : null;
}

export function decideAbstentionReplay(
  evidenceAttemptIds: readonly string[],
  abstention: SemanticAbstention | null,
): AbstentionReplay {
  if (!abstention) return { kind: 'no_prior_abstention' };
  const seen = new Set(abstention.seen_failure_attempt_ids);
  const fresh: string[] = [];
  const unique = new Set<string>();
  for (const id of evidenceAttemptIds) {
    if (unique.has(id) || seen.has(id)) continue;
    unique.add(id);
    fresh.push(id);
  }
  if (fresh.length === 0) return { kind: 'skip_unchanged' };
  const newEvidence: NewFailureAttemptEvidence = {
    kind: 'new_failure_attempt_ids',
    attempt_ids: fresh,
  };
  return {
    kind: 'reopen',
    reason_code: abstention.reason_code,
    explanation_md: abstention.explanation_md,
    seen_failure_attempt_ids: abstention.seen_failure_attempt_ids,
    new_failure_attempt_ids: fresh,
    new_evidence: newEvidence,
  };
}

export function reopenedAbstention(replay: AbstentionReplay): ReopenedAbstention | null {
  if (replay.kind !== 'reopen') return null;
  return {
    reason_code: replay.reason_code,
    explanation_md: replay.explanation_md,
    seen_failure_attempt_ids: replay.seen_failure_attempt_ids,
    new_failure_attempt_ids: replay.new_failure_attempt_ids,
  };
}

/** Latest semantic abstention per cell key. Operational rows are ignored. */
export async function loadSemanticAbstentionsByCell(
  db: Db,
  cells: readonly AbstentionCellRef[],
): Promise<Map<string, SemanticAbstention>> {
  const knowledgeIds = [...new Set(cells.map((cell) => cell.knowledge_id))];
  const out = new Map<string, SemanticAbstention>();
  if (knowledgeIds.length === 0) return out;

  const rows: Array<{
    id: string;
    subject_id: string;
    created_at: Date;
    outcome: string | null;
    payload: unknown;
  }> = [];
  for (let offset = 0; offset < knowledgeIds.length; offset += ABSTENTION_QUERY_CHUNK) {
    const chunk = knowledgeIds.slice(offset, offset + ABSTENTION_QUERY_CHUNK);
    rows.push(
      ...(await db
        .select({
          id: event.id,
          subject_id: event.subject_id,
          created_at: event.created_at,
          outcome: event.outcome,
          payload: event.payload,
        })
        .from(event)
        .where(
          and(
            eq(event.action, ABSTENTION_ACTION),
            eq(event.subject_kind, 'mind_model'),
            eq(event.outcome, 'partial'),
            inArray(event.subject_id, chunk),
          ),
        )
        .orderBy(desc(event.created_at), desc(event.id))
        .limit(ABSTENTION_ROW_CAP)),
    );
  }
  rows.sort(
    (left, right) =>
      right.created_at.getTime() - left.created_at.getTime() || right.id.localeCompare(left.id),
  );

  for (const row of rows) {
    const parsed = parseAbstention(row);
    if (!parsed?.semantic) continue;
    const cellKey = attributeAbstentionCellKey(parsed, cells);
    if (!cellKey || out.has(cellKey)) continue;
    out.set(cellKey, {
      cell_key: cellKey,
      abstained_at: parsed.abstained_at,
      seen_failure_attempt_ids: parsed.seen_failure_attempt_ids,
      reason_code: parsed.reason_code,
      explanation_md: parsed.explanation_md,
    });
  }
  return out;
}
