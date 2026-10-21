// Shared read model for the experimental:agent_note hint channel. The agency
// capability keeps the write side and learner-facing board projection.
//
// Notes are hints, not facts: they have provenance and expiry, and readers treat
// them as attention priors.
//
// Stored as generic ExperimentalEvent rows: actor_ref = source task kind,
// subject_kind = 'query', subject_id = note id, payload carries targets/refs/expiry.

import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

type DbLike = Db | Tx;

// Which background agents a note addresses. 'research_meeting' names the nightly
// meeting lane, not a writing actor; the deterministic lane reads no agent notes.
export type AgentNoteTarget = 'dreaming' | 'maintenance' | 'coach' | 'research_meeting' | 'copilot';

export interface AgentNoteRef {
  kind: string;
  id: string;
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
  // From the event column, not the payload; the board uses it as the evidence
  // fallback when refs[] is empty.
  caused_by_event_id?: string;
}

export interface ReadAgentNotesOpts {
  for_agent: AgentNoteTarget;
  now: Date;
  limit?: number;
  // Self-reinforcement guard: drop notes whose actor_ref (source_task_kind) is
  // listed, so an agent never treats its own prior notes as new evidence.
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

// Project one row; caused_by comes from the event column as the evidence fallback.
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
 * Recent unexpired notes addressed to for_agent, newest first. SQL applies the
 * target containment and expiry filter; notes are hints, never facts.
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
  // Drop notes written by excluded source kinds; an empty list adds no predicate.
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
 * Unexpired notes for any agent, newest first — the read-only observation board.
 * Same filters and ordering as readAgentNotes without the target predicate; it
 * never writes back.
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
