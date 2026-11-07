// Turn source ledger — the server-side record of every learner source the
// model could have seen this turn. Bound in the caller's ToolContext, never
// populated from model arguments; compose_block's drawing path refuses when
// the set is not provably complete (`complete=false`).
//
// Sources are authoritative ids in the usage-policy vocabulary
// (document/question/record/event/session). Anything the ledger cannot bind —
// aggregate projections, unbound history, unmapped read tools — marks the turn
// incomplete instead of guessing.

import type { PurposeSource } from '@/kernel/read-models/usage-policy';

export type SourceKind = PurposeSource['kind'];

/** Ledger-bound source: ids are always concrete strings, never SQL fragments. */
export interface BoundSource {
  kind: SourceKind;
  id: string;
}

export interface SourceLedgerSnapshot {
  readonly sources: readonly BoundSource[];
  /** false ⇒ at least one thing the model saw is not bound to an id. */
  readonly complete: boolean;
  /**
   * Scoped projections the ledger cannot enumerate row-by-row but CAN verify
   * globally (e.g. the learner-state header reads the whole state surface —
   * the provable closure is "no restricted source exists", not a row set).
   * Consumers run the scoped global check; they do not guess ids.
   */
  readonly scoped: readonly string[];
  /** Bounded audit trail of what could not be bound (kinds/reasons, no content). */
  readonly unknowns: readonly string[];
}

const MAX_SOURCES = 128;
const MAX_UNKNOWNS = 16;
const MAX_SCOPED = 8;

export class TurnSourceLedger {
  private readonly sources = new Map<string, BoundSource>();
  private readonly scoped = new Set<string>();
  private readonly unknowns: string[] = [];

  note(source: BoundSource): void {
    if (this.sources.size >= MAX_SOURCES) {
      this.noteUnknown('source_overflow');
      return;
    }
    this.sources.set(`${source.kind}:${source.id}`, source);
  }

  /**
   * Mark a provably-scoped aggregate input (the whole-learner projection the
   * caller assembled). Stays `complete`: the verifier checks the scope's veto
   * set globally rather than enumerating every contributing row.
   */
  noteScoped(label: string): void {
    if (this.scoped.size >= MAX_SCOPED && !this.scoped.has(label)) {
      this.noteUnknown(`scoped_overflow:${label}`);
      return;
    }
    this.scoped.add(label);
  }

  noteUnknown(why: string): void {
    if (this.unknowns.length < MAX_UNKNOWNS) this.unknowns.push(why);
  }

  snapshot(): SourceLedgerSnapshot {
    return {
      sources: [...this.sources.values()],
      complete: this.unknowns.length === 0,
      scoped: [...this.scoped],
      unknowns: [...this.unknowns],
    };
  }
}

/** Field names that carry a specific source kind; `id` is per-tool only. */
const FIELD_KINDS: Record<string, SourceKind> = {
  question_id: 'question',
  parent_question_id: 'question',
  variant_question_id: 'question',
  root_question_id: 'question',
  source_question_id: 'question',
  probe_question_id: 'question',
  record_id: 'record',
  source_record_id: 'record',
  event_id: 'event',
  caused_by_event_id: 'event',
  origin_event_id: 'event',
  attempt_event_id: 'event',
  judge_event_id: 'event',
  review_event_id: 'event',
  last_review_event_id: 'event',
  correction_event_id: 'event',
  replacement_event_id: 'event',
  conjecture_event_id: 'event',
  probe_result_event_id: 'event',
  focal_event_id: 'event',
  parent_event_id: 'event',
  source_attempt_event_id: 'event',
  session_id: 'session',
  ingestion_session_id: 'session',
  source_document_id: 'document',
  document_id: 'document',
};

const ARRAY_FIELD_KINDS: Record<string, SourceKind> = {
  question_ids: 'question',
  independent_probe_question_ids: 'question',
  record_ids: 'record',
  linked_record_ids: 'record',
  event_ids: 'event',
};

/**
 * Read tools whose outputs the ledger can fully bind. `bareId` maps every
 * `id`-shaped value in the output to that kind — over-binding a foreign id is
 * safe (the derivation check fails closed on a missing row) while
 * under-binding is the leak. Read tools NOT in this map mark the turn
 * incomplete: unbindable projections must refuse, not guess.
 */
const BINDABLE_READ_TOOLS: Record<string, { bareId?: SourceKind }> = {
  get_question_context: { bareId: 'question' },
  get_record_context: { bareId: 'record' },
  query_records: {},
  query_mistakes: {},
  query_events: { bareId: 'event' },
  get_attempt_context: {},
  get_review_due: {},
  search_bank: { bareId: 'question' },
  read_bank: { bareId: 'question' },
  check_bank: { bareId: 'question' },
};

function harvest(value: unknown, ledger: TurnSourceLedger, bareId: SourceKind | undefined): void {
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, ledger, bareId);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const fieldKind = FIELD_KINDS[key];
    if (fieldKind && typeof entry === 'string' && entry.length > 0) {
      ledger.note({ kind: fieldKind, id: entry });
      continue;
    }
    const arrayKind = ARRAY_FIELD_KINDS[key];
    if (arrayKind && Array.isArray(entry)) {
      for (const id of entry) {
        if (typeof id === 'string' && id.length > 0) ledger.note({ kind: arrayKind, id });
      }
      continue;
    }
    if (key === 'id' && bareId && typeof entry === 'string' && entry.length > 0) {
      ledger.note({ kind: bareId, id: entry });
      continue;
    }
    harvest(entry, ledger, bareId);
  }
}

/**
 * Record the learner-source ids one executed read tool exposed. Called by the
 * shared domain-tool bridge only after a read tool's output validated — a
 * failed call returns its error text, not learner content, so it binds nothing.
 */
export function recordToolReadSources(
  toolName: string,
  input: unknown,
  output: unknown,
  ledger: TurnSourceLedger | undefined,
): void {
  if (!ledger) return;
  const spec = BINDABLE_READ_TOOLS[toolName];
  if (!spec) {
    ledger.noteUnknown(`read_tool:${toolName}`);
    return;
  }
  // The input params also carry ids the model addressed (e.g. question_id).
  harvest(input, ledger, spec.bareId);
  harvest(output, ledger, spec.bareId);
}
