// U8 — leave_agent_note channel (AF spec §4 / §4.1, U0 D10/B8).
//
// Out-of-band hint channel for narrow tasks → background Dreaming / Maintenance
// runs. Distinct from `needs[]` (structured, durable, on the plan artifact,
// consumed by the next Coach round): agent notes are SOFT, best-effort hints
// with provenance + expiry for cross-context observations that have no home on
// a specific plan artifact. Both channels share the `signal_kind` vocabulary so
// the same observation classifies consistently regardless of carrier (§4.1).
//
// Notes are HINTS, NOT FACTS (§4 closing): they have provenance and expiry, and
// readers must treat them as attention priors, never as durable truth.
//
// STORAGE — zero schema change (AF §4 MVP, U0 D10 "S5 rides ExperimentalEvent"):
//   event(
//     action='experimental:agent_note',   // generic ExperimentalEvent catch-all
//     actor_kind='agent',                  // narrow tasks are agents
//     actor_ref=<source_task_kind>,        // who left it
//     subject_kind='query',                // not about a single durable record
//     subject_id=<note id>,                // self-referential, matches dreaming_scan
//     payload={ target_agents, refs, summary_md, signal_kind, confidence?,
//               expires_at?, source_task_kind, source_task_run_id? }
//   )
// `experimental:agent_note` is intentionally NOT in RESERVED_EXPERIMENTAL_ACTIONS
// (src/core/schema/event/experimental.ts) so it parses through the generic
// ExperimentalEvent escape hatch — no new Zod schema, no new table/column.
//
// YUK-293 adds the tool-loop wrapper in agent-note-tools.ts. Deterministic
// handlers (quiz_verify, etc.) continue to call this storage primitive directly.

import { createId } from '@paralleldrive/cuid2';

import type { Db, Tx } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { emitEvent } from '@/kernel/events';
import { and, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

// Which background agents a note is addressed to. Mirrors AF §4's conceptual
// tool signature target_agents. 'coach' is included per §4 (a task may leave a
// hint the next Coach round should weigh — distinct from the structured needs[]
// channel, which Coach consumes as plan input).
//
// YUK-572 — 'research_meeting' names the nightly 教研例会 CHANNEL (an attention prior
// for the meeting lane), NOT a per-actor writer. Its current reader is the agent-lane
// director's get_agent_notes (readAgentNotes for_agent:'research_meeting'); the
// deterministic lane reads no agent_notes. Naming the channel (not the writing actor)
// keeps it stable across future meeting forms; self-bias is handled orthogonally on
// the writer axis via excludeSourceKinds (see ReadAgentNotesOpts).
export type AgentNoteTarget = 'dreaming' | 'maintenance' | 'coach' | 'research_meeting' | 'copilot';

export interface AgentNoteRef {
  kind: string;
  id: string;
}

export interface WriteAgentNoteInput {
  target_agents: AgentNoteTarget[];
  source_task_kind: string;
  source_task_run_id?: string;
  refs: AgentNoteRef[];
  summary_md: string;
  signal_kind: string;
  confidence?: number;
  // ISO-8601. Omit for a non-expiring hint. readAgentNotes() filters on this.
  expires_at?: string;
  // Optional chain link to the event that triggered the observation (e.g. the
  // quiz_verify event that found the pool gap), for evidence-first traceability.
  caused_by_event_id?: string;
}

export interface AgentNote {
  id: string;
  created_at: Date;
  target_agents: AgentNoteTarget[];
  source_task_kind: string;
  source_task_run_id?: string;
  refs: AgentNoteRef[];
  summary_md: string;
  signal_kind: string;
  confidence?: number;
  expires_at?: string;
  // Chain link to the event that triggered the observation (mirrors the
  // writeAgentNote `caused_by_event_id` input). Sourced from the EVENT COLUMN
  // event.caused_by_event_id — NOT the payload. The agent-notes board uses it as
  // the evidence fallback when refs[] is empty (YUK-294); readAgentNotes readers
  // benefit too. Optional — a note may have no triggering event.
  caused_by_event_id?: string;
}

export type AgentNoteReferenceState = 'open' | 'resolved' | 'unknown';

/**
 * Additive read-model context for the learner-facing observation board.
 *
 * The write protocol remains `{ kind, id }`. Labels and current resolution are
 * derived at read time so historical events stay immutable and every raw ref
 * remains available for audit navigation without becoming learner-facing copy.
 */
export interface AgentNoteBoardRef extends AgentNoteRef {
  label: string;
  resolution_state: AgentNoteReferenceState;
  usable_question_count?: number;
}

export interface AgentNoteBoardRow extends Omit<AgentNote, 'refs'> {
  refs: AgentNoteBoardRef[];
}

/**
 * Persist one agent note as an `experimental:agent_note` event. Returns the
 * note id (= event subject_id). Idempotent via the underlying writeEvent PK
 * conflict do-nothing (re-running with the same id is safe).
 *
 * The note is a hint, not a fact — it carries provenance (source_task_kind /
 * source_task_run_id / refs) and optional expiry; readers must treat it as an
 * attention prior, never durable truth.
 */
export async function writeAgentNote(db: DbLike, input: WriteAgentNoteInput): Promise<string> {
  const noteId = `agent_note_${createId()}`;
  await emitEvent(db, {
    id: noteId,
    actor_kind: 'agent',
    actor_ref: input.source_task_kind,
    action: 'experimental:agent_note',
    subject_kind: 'query',
    subject_id: noteId,
    outcome: null,
    payload: {
      target_agents: input.target_agents,
      refs: input.refs,
      summary_md: input.summary_md,
      signal_kind: input.signal_kind,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      source_task_kind: input.source_task_kind,
      ...(input.source_task_run_id !== undefined
        ? { source_task_run_id: input.source_task_run_id }
        : {}),
    },
    caused_by_event_id: input.caused_by_event_id ?? null,
    task_run_id: input.source_task_run_id ?? null,
  });
  return noteId;
}

export interface ReadAgentNotesOpts {
  for_agent: AgentNoteTarget;
  now: Date;
  limit?: number;
  // YUK-572 §7 — self-reinforcement guard. When non-empty, notes whose actor_ref
  // (= source_task_kind, set by writeAgentNote) is in this list are excluded, so an
  // agent's get_agent_notes never surfaces its OWN prior notes and close a confirmation
  // loop (its old conclusion masquerading as new evidence). Omitted/empty ⇒ no filter.
  excludeSourceKinds?: string[];
}

export interface ReadAllAgentNotesOpts {
  now: Date;
  limit?: number;
}

const DEFAULT_AGENT_NOTES_LIMIT = 20;

// Minimal row shape needed to project an AgentNote. Both readAgentNotes and
// readAllAgentNotes pass full event rows; this captures only the fields used.
type AgentNoteEventRow = {
  id: string;
  created_at: Date;
  actor_ref: string;
  caused_by_event_id: string | null;
  payload: unknown;
};

// Project one experimental:agent_note event row to an AgentNote. caused_by_event_id
// comes from the EVENT COLUMN (not the payload) — it is the evidence-fallback
// chain link the agent-notes board relies on when refs[] is empty (YUK-294).
function rowToAgentNote(row: AgentNoteEventRow): AgentNote {
  const p = (row.payload ?? {}) as {
    target_agents?: AgentNoteTarget[];
    refs?: AgentNoteRef[];
    summary_md?: string;
    signal_kind?: string;
    confidence?: number;
    expires_at?: string;
    source_task_kind?: string;
    source_task_run_id?: string;
  };
  const note: AgentNote = {
    id: row.id,
    created_at: row.created_at,
    target_agents: p.target_agents ?? [],
    source_task_kind: p.source_task_kind ?? row.actor_ref,
    refs: p.refs ?? [],
    summary_md: p.summary_md ?? '',
    signal_kind: p.signal_kind ?? 'unknown',
  };
  if (p.source_task_run_id !== undefined) note.source_task_run_id = p.source_task_run_id;
  if (p.confidence !== undefined) note.confidence = p.confidence;
  if (p.expires_at !== undefined) note.expires_at = p.expires_at;
  if (row.caused_by_event_id) note.caused_by_event_id = row.caused_by_event_id;
  return note;
}

/**
 * Read recent un-expired agent notes addressed to `for_agent`, newest first.
 *
 * Filtering happens in two layers:
 *   - SQL: action='experimental:agent_note', subject_kind='query',
 *     target_agents @> [for_agent] (jsonb containment), and
 *     (expires_at IS NULL OR expires_at > now) so stale hints never surface.
 *   - The `?` jsonb-text-key check keeps the predicate index-friendly while the
 *     payload stays a loose record (generic ExperimentalEvent shape).
 *
 * Notes are hints — callers inject them as context labelled "hints, not facts"
 * (see dreaming_nightly.ts / knowledge/review.ts injection sites).
 */
export async function readAgentNotes(db: DbLike, opts: ReadAgentNotesOpts): Promise<AgentNote[]> {
  const limit = opts.limit ?? DEFAULT_AGENT_NOTES_LIMIT;
  if (limit <= 0) return [];
  const nowIso = opts.now.toISOString();

  const conditions = [
    eq(event.action, 'experimental:agent_note'),
    eq(event.subject_kind, 'query'),
    // target_agents array contains for_agent (jsonb containment).
    sql`${event.payload}->'target_agents' @> ${JSON.stringify([opts.for_agent])}::jsonb`,
    // Un-expired only: no expires_at OR expires_at strictly in the future.
    sql`(NOT (${event.payload} ? 'expires_at') OR (${event.payload}->>'expires_at') > ${nowIso})`,
  ];
  // YUK-572 §7 — self-reinforcement guard: drop notes written by the excluded source
  // kinds (actor_ref = source_task_kind). Empty list ⇒ no predicate added.
  if (opts.excludeSourceKinds && opts.excludeSourceKinds.length > 0) {
    conditions.push(notInArray(event.actor_ref, opts.excludeSourceKinds));
  }

  const rows = await db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(limit);

  return rows.map(rowToAgentNote);
}

/**
 * Read recent un-expired agent notes addressed to ANY agent, newest first.
 *
 * The unfiltered variant of readAgentNotes for the read-only "AI 观察" board
 * (YUK-294): the user spectates every cross-agent observation, so there is no
 * for_agent containment predicate. Everything else matches readAgentNotes —
 * same action + subject_kind, same un-expired filter, same newest-first order
 * and limit clamp — so the board never surfaces stale hints.
 *
 * Still HINTS, not facts: the board is a read-only spectator surface with no
 * accept/dismiss; it never writes back.
 */
export async function readAllAgentNotes(
  db: DbLike,
  opts: ReadAllAgentNotesOpts,
): Promise<AgentNote[]> {
  const limit = opts.limit ?? DEFAULT_AGENT_NOTES_LIMIT;
  if (limit <= 0) return [];
  const nowIso = opts.now.toISOString();

  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:agent_note'),
        eq(event.subject_kind, 'query'),
        // Un-expired only: no expires_at OR expires_at strictly in the future.
        sql`(NOT (${event.payload} ? 'expires_at') OR (${event.payload}->>'expires_at') > ${nowIso})`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(limit);

  return rows.map(rowToAgentNote);
}

/**
 * Learner-facing board projection for agent notes.
 *
 * Knowledge and question references receive a human label and a current
 * resolution state. A historical question-pool-gap is considered resolved once
 * the referenced knowledge point has at least one usable question
 * (`draft_status IS DISTINCT FROM 'draft'`). The original note and ref ids are
 * neither changed nor discarded; this is an additive read projection only.
 */
export async function readAgentNoteBoardRows(
  db: DbLike,
  opts: ReadAllAgentNotesOpts,
): Promise<AgentNoteBoardRow[]> {
  const notes = await readAllAgentNotes(db, opts);
  if (notes.length === 0) return [];

  const knowledgeIds = Array.from(
    new Set(
      notes.flatMap((note) =>
        note.refs.filter((ref) => ref.kind === 'knowledge').map((ref) => ref.id),
      ),
    ),
  );
  const questionIds = Array.from(
    new Set(
      notes.flatMap((note) =>
        note.refs.filter((ref) => ref.kind === 'question').map((ref) => ref.id),
      ),
    ),
  );

  const knowledgeRows =
    knowledgeIds.length > 0
      ? await db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(inArray(knowledge.id, knowledgeIds))
      : [];
  const knowledgeNames = new Map(knowledgeRows.map((row) => [row.id, row.name]));

  const usableQuestionCounts = new Map<string, number>();
  if (knowledgeIds.length > 0) {
    const questionRows = await db
      .select({ knowledge_ids: question.knowledge_ids, draft_status: question.draft_status })
      .from(question)
      .where(
        or(
          ...knowledgeIds.map(
            (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
          ),
        ),
      );
    for (const row of questionRows) {
      if (row.draft_status === 'draft') continue;
      for (const id of row.knowledge_ids) {
        if (!knowledgeNames.has(id)) continue;
        usableQuestionCounts.set(id, (usableQuestionCounts.get(id) ?? 0) + 1);
      }
    }
  }

  const questionRows =
    questionIds.length > 0
      ? await db
          .select({
            id: question.id,
            prompt_md: question.prompt_md,
            draft_status: question.draft_status,
          })
          .from(question)
          .where(inArray(question.id, questionIds))
      : [];
  const questionContext = new Map(questionRows.map((row) => [row.id, row]));

  return notes.map((note) => ({
    ...note,
    refs: note.refs.map((ref): AgentNoteBoardRef => {
      if (ref.kind === 'knowledge') {
        const usableCount = usableQuestionCounts.get(ref.id) ?? 0;
        return {
          ...ref,
          label: knowledgeNames.get(ref.id) ?? '未命名知识点',
          resolution_state: knowledgeNames.has(ref.id)
            ? usableCount > 0
              ? 'resolved'
              : 'open'
            : 'unknown',
          usable_question_count: usableCount,
        };
      }
      if (ref.kind === 'question') {
        const context = questionContext.get(ref.id);
        return {
          ...ref,
          label: context?.prompt_md.trim().slice(0, 48) || '相关题目',
          resolution_state: context
            ? context.draft_status === 'draft'
              ? 'open'
              : 'resolved'
            : 'unknown',
        };
      }
      if (ref.kind === 'event') {
        return { ...ref, label: '事件证据', resolution_state: 'unknown' };
      }
      if (ref.kind === 'note' || ref.kind === 'artifact') {
        return { ...ref, label: '相关笔记', resolution_state: 'unknown' };
      }
      return { ...ref, label: '相关证据', resolution_state: 'unknown' };
    }),
  }));
}
