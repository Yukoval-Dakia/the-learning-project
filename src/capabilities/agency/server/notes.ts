// Agent-note channel: out-of-band hints for narrow tasks → background Dreaming /
// Maintenance runs. Distinct from `needs[]` (structured, durable, on the plan artifact):
// notes are SOFT, best-effort hints with provenance + expiry, sharing the `signal_kind`
// vocabulary. They are HINTS, NOT FACTS — readers treat them as attention priors.
//
// STORAGE — zero schema change: one `experimental:agent_note` ExperimentalEvent
// (intentionally NOT reserved) with payload { target_agents, refs, summary_md, signal_kind,
// confidence?, expires_at?, source_task_kind, source_task_run_id? }. Product hints stay
// owner commands. quiz_verify does not import this module: Agency applies
// recordQuestionPoolGap when it reads a committed non-promotion verification event.

import { createId } from '@paralleldrive/cuid2';
import { inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  type AgentNote,
  type AgentNoteRef,
  type AgentNoteTarget,
  type ReadAllAgentNotesOpts,
  readAllAgentNotes,
} from '@/kernel/read-models/agent-note-hints';

// The read side lives in @/kernel/read-models/agent-note-hints; these re-exports keep this
// module's compat surface (agency-internal consumers + agency/public). The write side and
// the learner-facing board projection stay owned here.
export type {
  AgentNote,
  AgentNoteRef,
  AgentNoteTarget,
  ReadAgentNotesOpts,
  ReadAllAgentNotesOpts,
} from '@/kernel/read-models/agent-note-hints';
export { readAgentNotes, readAllAgentNotes } from '@/kernel/read-models/agent-note-hints';

type DbLike = Db | Tx;

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

export type AgentNoteReferenceState = 'open' | 'resolved' | 'unknown';

/**
 * Additive read-model context for the learner-facing observation board. Labels and current
 * resolution are derived at read time, so historical events stay immutable and raw refs stay
 * available for audit navigation without becoming learner-facing copy.
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
 * Persist one agent note; returns the new note id (= event id). Each call mints a
 * separate note, so a pg-boss retry creates a new note rather than deduping.
 */
export async function writeAgentNote(db: DbLike, input: WriteAgentNoteInput): Promise<string> {
  const noteId = `agent_note_${createId()}`;
  await writeEvent(db, {
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

/** Interpret a committed verification's pool gap as an expiring coach hint, not a durable fact. */
export function recordQuestionPoolGap(
  db: DbLike,
  observation: {
    questionId: string;
    knowledgeIds: readonly string[] | null;
    verificationStatus: string;
    confidence: number;
    taskRunId: string | null;
    verificationEventId: string;
    observedAt: Date;
  },
): Promise<string> {
  const knowledgeIds = observation.knowledgeIds ?? [];
  return writeAgentNote(db, {
    target_agents: ['coach'],
    source_task_kind: 'quiz_verify',
    source_task_run_id: observation.taskRunId ?? undefined,
    refs:
      knowledgeIds.length > 0
        ? knowledgeIds.map((id) => ({ kind: 'knowledge', id }))
        : [{ kind: 'question', id: observation.questionId }],
    signal_kind: 'question_pool_gap',
    summary_md: `Generated question ${observation.questionId} did not enter the review pool (verification ${observation.verificationStatus}); its knowledge point(s) may still lack a usable question.`,
    confidence: observation.confidence,
    expires_at: new Date(observation.observedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    caused_by_event_id: observation.verificationEventId,
  });
}

/**
 * Learner-facing board projection: knowledge and question refs get a human label and a
 * current resolution state. A question-pool-gap is resolved once the referenced KC has at
 * least one usable question (`draft_status IS DISTINCT FROM 'draft'`). Original note and ref
 * ids are neither changed nor discarded; this is additive only.
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
